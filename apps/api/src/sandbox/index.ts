import type { Config } from '../config/env.js';
import { ApiError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';
import { DockerSandboxDriver } from './docker-driver.js';
import { LocalSandboxDriver } from './local-driver.js';
import type { SandboxDriver } from './driver.js';

export interface SandboxInitResult {
  driver: SandboxDriver;
  note: string;
  isolated: boolean;
}

let singleton: SandboxDriver | undefined;

export async function initSandbox(config: Config): Promise<SandboxInitResult> {
  if (singleton) {
    return {
      driver: singleton,
      note: singleton.isolationNote,
      isolated: singleton.id === 'docker',
    };
  }

  if (!config.env.SANDBOX_ENABLED) {
    throw new Error(
      'SANDBOX_ENABLED=false. Wolf Forge refuses to run generated projects without a sandbox ' +
        'because generated source code is untrusted. Set SANDBOX_ENABLED=true.',
    );
  }

  const requested = config.env.SANDBOX_DRIVER;
  const log = childLogger({ component: 'sandbox' });

  if (requested !== 'local') {
    const docker = new DockerSandboxDriver(config);
    if (await docker.available()) {
      singleton = docker;
      log.info({ driver: 'docker' }, 'sandbox ready');
      return { driver: docker, note: docker.isolationNote, isolated: true };
    }
    if (requested === 'docker') {
      throw new ApiError(
        'sandbox_unavailable',
        'SANDBOX_DRIVER=docker but the Docker daemon is not reachable. Start Docker, or set ' +
          'SANDBOX_DRIVER=local to accept reduced isolation in development.',
        { status: 503 },
      );
    }
    log.warn({ driver: 'local' }, 'docker unavailable, falling back to reduced-isolation driver');
  }

  const local = new LocalSandboxDriver(config);
  singleton = local;
  log.warn(
    'sandbox ready — REDUCED ISOLATION (no Docker). Not suitable for untrusted projects.',
  );
  return { driver: local, note: local.isolationNote, isolated: false };
}

export function getSandbox(): SandboxDriver {
  if (!singleton) throw new Error('Sandbox accessed before initSandbox() completed');
  return singleton;
}

export function setSandboxForTesting(driver: SandboxDriver): void {
  singleton = driver;
}
