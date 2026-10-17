import crypto from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config/env.js';
import { ApiError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';
import { runProcess, type ExecRequest, type ExecResult, type SandboxDriver } from './driver.js';

interface ContainerHandle {
  containerName: string;
  hostPort: number | null;
}

/**
 * Docker-backed sandbox for untrusted generated projects.
 *
 * Controls applied to every container:
 *   --network none            (unless the command is a dependency install)
 *   --memory / --memory-swap  (equal, so swap cannot be used to exceed the cap)
 *   --cpus, --pids-limit      (CPU and fork-bomb limits)
 *   --read-only rootfs + tmpfs (container cannot write outside the bind mount)
 *   --cap-drop ALL, no-new-privileges
 *   --user 1000:1000          (never root)
 *   --security-opt no-new-privileges
 *   --ulimit nofile            (file-descriptor limit)
 *
 * A Docker container is not a perfect security boundary. Wolf Forge treats it
 * as one layer: dependencies are additionally allowlisted, commands are never
 * shell-interpreted, output is size-capped, and the bind mount is a per-job
 * temporary directory containing only the generated project.
 */
export class DockerSandboxDriver implements SandboxDriver {
  readonly id = 'docker' as const;
  readonly isolationNote =
    'Generated projects run in a Docker container with dropped capabilities, no root user, ' +
    'a read-only root filesystem, memory/CPU/PID limits and no outbound network during build.';

  private readonly containers = new Map<string, ContainerHandle>();

  constructor(private readonly config: Config) {}

  async available(): Promise<boolean> {
    try {
      const res = await runProcess('docker', ['info', '--format', '{{.ServerVersion}}'], {
        cwd: process.cwd(),
        env: safeEnv(),
        timeoutMs: 15_000,
      });
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }

  private baseArgs(workspaceDir: string, network: 'none' | 'bridge' | 'preview'): string[] {
    const env = this.config.env;
    // 'preview' resolves to a dedicated internal bridge (created on demand):
    // port publishing needs NAT, which 'none' lacks, but the network has no
    // external route so the container still cannot reach the outside world.
    const dockerNetwork = network === 'preview' ? 'wolf-forge-preview' : network;
    const args = [
      'run',
      '--rm',
      '--init',
      '--network',
      dockerNetwork,
      '--memory',
      `${env.SANDBOX_MEMORY_MB}m`,
      '--memory-swap',
      `${env.SANDBOX_MEMORY_MB}m`,
      '--cpus',
      String(env.SANDBOX_CPUS),
      '--pids-limit',
      String(env.SANDBOX_PIDS_LIMIT),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '1000:1000',
      '--workdir',
      '/workspace',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=256m',
      '-v',
      `${path.resolve(workspaceDir)}:/workspace:rw`,
      // No host environment leaks into the container.
      '-e',
      'HOME=/tmp',
      '-e',
      'npm_config_cache=/tmp/.npm',
      '-e',
      'npm_config_update_notifier=false',
      '-e',
      'CI=1',
    ];
    return args;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const network = this.networkFor(request);
    const containerName = `wolf-forge-${crypto.randomBytes(6).toString('hex')}`;

    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(request.env ?? {})) {
      // Guard against environment injection through generated content.
      if (!/^[A-Z0-9_]{1,64}$/.test(key)) continue;
      envArgs.push('-e', `${key}=${value}`);
    }

    const args = [
      ...this.baseArgs(request.workspaceDir, network),
      ...envArgs,
      '--name',
      containerName,
      this.config.env.SANDBOX_IMAGE,
      request.command,
      ...request.args,
    ];

    const res = await runProcess('docker', args, {
      cwd: process.cwd(),
      env: safeEnv(),
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (res.cancelled || res.timedOut) {
      // runProcess killed the docker CLI; make sure the container is gone too.
      await this.stopServer(containerName);
    }
    return res;
  }

  private networkFor(request: ExecRequest): 'none' | 'bridge' {
    // Only dependency installation is allowed to reach the network, and only
    // when the operator has enabled it.
    const needsNetwork = request.command === 'npm' || request.command === 'node';
    const isInstall = request.args[0] === 'install' || request.args[0] === 'ci';
    if (!this.config.env.SANDBOX_ALLOW_NETWORK) return 'none';
    return needsNetwork && isInstall ? 'bridge' : 'none';
  }

  private previewNetworkReady = false;

  /**
   * Creates the isolated preview bridge once per process. Internal (no
   * external route) but with NAT for published-port loopback access.
   */
  private async ensurePreviewNetwork(): Promise<void> {
    if (this.previewNetworkReady) return;
    const res = await runProcess('docker', ['network', 'inspect', 'wolf-forge-preview'], {
      cwd: process.cwd(),
      env: safeEnv(),
      timeoutMs: 15_000,
    });
    if (res.exitCode !== 0) {
      await runProcess('docker', ['network', 'create', '--internal', '--driver', 'bridge', 'wolf-forge-preview'], {
        cwd: process.cwd(),
        env: safeEnv(),
        timeoutMs: 30_000,
      });
    }
    this.previewNetworkReady = true;
  }

  /**
   * Starts a long-running preview server detached, then polls the published
   * port until it actually answers. The URL is only reported once the service
   * responds, so a preview is never claimed before it works.
   *
   * NOTE: the preview container uses a private bridge network, not
   * `--network none`: port publishing requires a network stack with NAT, and
   * with `none` the mapping is created but never reachable from the host.
   * The server still binds to the container loopback and is published only
   * to the host loopback, so it stays unreachable from the wider network.
   */
  async startServer(request: ExecRequest): Promise<{ handle: string; hostPort: number }> {
    const hostPort = request.hostPort;
    if (!hostPort) throw ApiError.internal('startServer requires a hostPort');

    const containerName = `wolf-forge-preview-${crypto.randomBytes(6).toString('hex')}`;
    await this.ensurePreviewNetwork();
    const args = [
      ...this.baseArgs(request.workspaceDir, 'preview'),
      '-p',
      // Bind to loopback only: the preview is reachable by the API and the
      // user's browser session, never from the wider network.
      `127.0.0.1:${hostPort}:${request.publishPort ?? 4173}`,
      '--name',
      containerName,
      '-d',
      this.config.env.SANDBOX_IMAGE,
      request.command,
      ...request.args,
    ];

    const res = await runProcess('docker', args, {
      cwd: process.cwd(),
      env: safeEnv(),
      timeoutMs: 60_000,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (res.exitCode !== 0) {
      throw ApiError.internal('Failed to start the preview container', {
        output: res.output.slice(0, 800),
      });
    }

    this.containers.set(containerName, { containerName, hostPort });
    return { handle: containerName, hostPort };
  }

  async stopServer(handle: string): Promise<void> {
    await runProcess('docker', ['rm', '-f', handle], {
      cwd: process.cwd(),
      env: safeEnv(),
      timeoutMs: 30_000,
    }).catch(() => undefined);
    this.containers.delete(handle);
  }

  async cleanup(workspaceDir: string): Promise<void> {
    for (const handle of [...this.containers.keys()]) {
      await this.stopServer(handle);
    }
    const log = childLogger({ sandbox: 'docker' });
    log.debug({ workspaceDir }, 'sandbox cleanup complete');
  }
}

/** Minimal environment for the docker CLI itself — never the API's own env. */
function safeEnv(): Record<string, string> {
  const keep = (name: string): [string, string] | null =>
    name === 'DOCKER_HOST' ? [name, process.env[name] ?? ''] : null;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
  };
  const host = keep('DOCKER_HOST');
  if (host) env[host[0]] = host[1];
  return env;
}
