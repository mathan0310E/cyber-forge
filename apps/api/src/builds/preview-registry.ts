import crypto from 'node:crypto';
import type { Config } from '../config/env.js';
import { ApiError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';
import { getSandbox } from '../sandbox/index.js';
import type { SandboxDriver } from '../sandbox/driver.js';

export interface PreviewHandle {
  id: string;
  projectId: string;
  versionId: string;
  ownerUid: string;
  /** Host port the sandbox published. */
  port: number;
  sandboxHandle: string;
  workspaceDir: string;
  /** Token required to fetch through the proxy, so one user cannot read another's preview. */
  accessToken: string;
  startedAt: number;
  lastUsedAt: number;
  driver: SandboxDriver['id'];
}

/**
 * Tracks running preview servers.
 *
 * Previews are proxied through the API rather than exposed directly:
 *  - the container binds to loopback only,
 *  - the proxy requires the owner's session and a per-preview access token,
 *  - responses get a restrictive CSP and the preview runs on an isolated
 *    origin path, so generated code cannot read the app's own session.
 */
export class PreviewRegistry {
  private readonly previews = new Map<string, PreviewHandle>();
  private readonly byProject = new Map<string, string>();
  private readonly ttlMs: number;

  constructor(config: Config) {
    this.ttlMs = Math.max(config.env.QUOTA_MAX_BUILD_DURATION_MS, 30 * 60 * 1000);
  }

  get(id: string): PreviewHandle | null {
    return this.previews.get(id) ?? null;
  }

  getForProject(projectId: string): PreviewHandle | null {
    const id = this.byProject.get(projectId);
    return id ? (this.previews.get(id) ?? null) : null;
  }

  /** Validates ownership and the access token in one step. */
  authorize(id: string, ownerUid: string, token: string): PreviewHandle {
    const preview = this.previews.get(id);
    if (!preview) throw ApiError.notFound('Preview is not running. Rebuild the project.');
    if (preview.ownerUid !== ownerUid) throw ApiError.notFound('Preview not found');
    const expected = Buffer.from(preview.accessToken);
    const provided = Buffer.from(token);
    if (
      expected.length !== provided.length ||
      !crypto.timingSafeEqual(expected, provided)
    ) {
      throw ApiError.forbidden('Invalid preview access token');
    }
    preview.lastUsedAt = Date.now();
    return preview;
  }

  async start(input: {
    projectId: string;
    versionId: string;
    ownerUid: string;
    workspaceDir: string;
    command: string;
    args: string[];
    port: number;
    /** Container-side port; defaults to `port` (local driver ignores it). */
    publishPort?: number;
    /** Milliseconds to wait for the server to answer before giving up. */
    readyTimeoutMs: number;
  }): Promise<PreviewHandle> {
    const sandbox = getSandbox();
    const log = childLogger({ component: 'preview', projectId: input.projectId });

    // One preview per project: stop any previous instance first so ports and
    // containers do not accumulate.
    await this.stopForProject(input.projectId);

    const handle = await sandbox.startServer({
      workspaceDir: input.workspaceDir,
      command: input.command,
      args: input.args,
      timeoutMs: input.readyTimeoutMs,
      label: 'preview',
      hostPort: input.port,
      publishPort: input.publishPort ?? input.port,
    });

    const ready = await waitForHttp(`http://127.0.0.1:${handle.hostPort}/`, input.readyTimeoutMs);
    if (!ready) {
      await sandbox.stopServer(handle.handle);
      throw ApiError.internal(
        'The generated site did not start serving within the time limit. The build may have ' +
          'produced no output, or the preview server may have crashed on startup.',
        { hostPort: handle.hostPort },
      );
    }

    const preview: PreviewHandle = {
      id: `prv_${crypto.randomBytes(10).toString('hex')}`,
      projectId: input.projectId,
      versionId: input.versionId,
      ownerUid: input.ownerUid,
      port: handle.hostPort,
      sandboxHandle: handle.handle,
      workspaceDir: input.workspaceDir,
      accessToken: crypto.randomBytes(24).toString('hex'),
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      driver: sandbox.id,
    };

    this.previews.set(preview.id, preview);
    this.byProject.set(input.projectId, preview.id);
    log.info({ previewId: preview.id, port: preview.port }, 'preview ready');
    return preview;
  }

  async stop(previewId: string): Promise<void> {
    const preview = this.previews.get(previewId);
    if (!preview) return;
    this.previews.delete(previewId);
    if (this.byProject.get(preview.projectId) === previewId) {
      this.byProject.delete(preview.projectId);
    }
    await getSandbox().stopServer(preview.sandboxHandle).catch(() => undefined);
  }

  async stopForProject(projectId: string): Promise<void> {
    const id = this.byProject.get(projectId);
    if (id) await this.stop(id);
  }

  /** Marks a preview as recently used so the idle reaper leaves it alone. */
  touch(previewId: string): void {
    const preview = this.previews.get(previewId);
    if (preview) preview.lastUsedAt = Date.now();
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.previews.keys()]) {
      await this.stop(id);
    }
  }

  /** Stops previews that have not been requested within the TTL. */
  async reapIdle(): Promise<number> {
    const now = Date.now();
    let reaped = 0;
    for (const preview of [...this.previews.values()]) {
      if (now - preview.lastUsedAt > this.ttlMs) {
        await this.stop(preview.id);
        reaped += 1;
      }
    }
    return reaped;
  }

  get activeCount(): number {
    return this.previews.size;
  }
}

/**
 * Polls until the preview server answers. Returns false on timeout rather than
 * throwing, so the caller can decide how to report the failure.
 */
async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 150;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
      clearTimeout(timer);
      // Any HTTP response means the server is listening and serving.
      if (res.status > 0) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 1_000);
  }
  return false;
}

export { waitForHttp };

let singleton: PreviewRegistry | undefined;

export function initPreviewRegistry(config: Config): PreviewRegistry {
  singleton = new PreviewRegistry(config);
  return singleton;
}

export function getPreviewRegistry(): PreviewRegistry {
  if (!singleton) throw new Error('Preview registry accessed before initialisation');
  return singleton;
}
