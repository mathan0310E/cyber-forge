import crypto from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config/env.js';
import { ApiError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';
import { runProcess, type ExecRequest, type ExecResult, type SandboxDriver } from './driver.js';

interface ServerHandle {
  child: import('node:child_process').ChildProcess;
  hostPort: number;
  pid: number;
}

/**
 * Local (no-container) sandbox driver.
 *
 * This driver does NOT provide filesystem or network isolation. It exists so
 * that Wolf Forge can run in environments without Docker, and it is always
 * reported as "reduced isolation" in the UI and in /health. When Docker is
 * available the Docker driver is preferred automatically.
 *
 * The controls it does apply:
 *  - the command runs with a scrubbed environment (no API keys, no provider
 *    credentials) in a per-job directory,
 *  - processes are started in their own process group and killed as a group,
 *  - every command has a hard timeout and a captured-output cap.
 */
export class LocalSandboxDriver implements SandboxDriver {
  readonly id = 'local' as const;
  readonly isolationNote =
    'REDUCED ISOLATION: generated projects run as local processes without container isolation. ' +
    'Docker is not available in this environment, so filesystem and network limits are not enforced. ' +
    'Only run projects you trust, and enable Docker for real isolation.';

  private readonly servers = new Map<string, ServerHandle>();

  constructor(private readonly config: Config) {}

  async available(): Promise<boolean> {
    return true;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    return runProcess(request.command, request.args, {
      cwd: request.workspaceDir,
      env: this.scrubbedEnv(request.env),
      timeoutMs: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  /**
   * Starts the preview server detached. The process group is recorded so it can
   * be killed cleanly, and the environment never carries provider secrets.
   */
  async startServer(request: ExecRequest): Promise<{ handle: string; hostPort: number }> {
    const hostPort = request.hostPort;
    if (!hostPort) throw ApiError.internal('startServer requires a hostPort');

    const { spawn } = await import('node:child_process');
    const child = spawn(request.command, request.args, {
      cwd: request.workspaceDir,
      env: {
        ...this.scrubbedEnv(request.env),
        PORT: String(hostPort),
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });

    const handle = `local-${crypto.randomBytes(6).toString('hex')}`;
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', () => undefined);
    child.on('error', () => this.servers.delete(handle));

    this.servers.set(handle, { child, hostPort, pid: child.pid ?? -1 });
    child.unref();

    return { handle, hostPort };
  }

  async stopServer(handle: string): Promise<void> {
    const entry = this.servers.get(handle);
    if (!entry) return;
    this.servers.delete(handle);
    if (entry.pid > 0) {
      try {
        process.kill(-entry.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(entry.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }

  async cleanup(workspaceDir: string): Promise<void> {
    for (const handle of [...this.servers.keys()]) {
      await this.stopServer(handle);
    }
    childLogger({ sandbox: 'local' }).debug({ workspaceDir }, 'local sandbox cleanup complete');
  }

  /**
   * Only a minimal, non-secret environment is forwarded. Provider keys, the
   * integration encryption key and Firebase credentials are all excluded, so a
   * generated project can never read them.
   */
  private scrubbedEnv(extra?: Record<string, string>): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      LANG: 'C.UTF-8',
      CI: '1',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      ...(extra ?? {}),
    };
  }

  get workspaceRoot(): string {
    return path.resolve(this.config.env.ARTIFACT_STORAGE_PATH);
  }
}
