import { EventEmitter } from 'node:events';
import type { BuildEvent } from '@wolf-forge/shared-types';

/**
 * In-process pub/sub for build events.
 *
 * The SSE endpoint subscribes here and also replays persisted events from the
 * job's sequence number, so a client that reconnects never misses or duplicates
 * an event. When more than one API instance is running, the persisted events
 * remain the source of truth and this emitter only provides low-latency pushes.
 */
class BuildEventBus extends EventEmitter {
  constructor() {
    super();
    // A single build can fan out to several SSE subscribers (multiple tabs).
    this.setMaxListeners(500);
  }

  publish(event: BuildEvent): void {
    this.emit(channel(event.jobId), event);
  }

  subscribe(jobId: string, listener: (event: BuildEvent) => void): () => void {
    const ch = channel(jobId);
    this.on(ch, listener);
    return () => this.off(ch, listener);
  }
}

function channel(jobId: string): string {
  return `job:${jobId}`;
}

export const buildEvents = new BuildEventBus();

/**
 * Registry of running jobs, used for cancellation and to enforce the
 * concurrent-build quota within a single process.
 */
class CancellationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(jobId: string): AbortController {
    const existing = this.controllers.get(jobId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    return controller;
  }

  signal(jobId: string): AbortSignal | undefined {
    return this.controllers.get(jobId)?.signal;
  }

  cancel(jobId: string): boolean {
    const controller = this.controllers.get(jobId);
    if (!controller) return false;
    controller.abort(new Error('cancelled by user'));
    return true;
  }

  isRunning(jobId: string): boolean {
    return this.controllers.has(jobId);
  }

  release(jobId: string): void {
    this.controllers.delete(jobId);
  }

  get size(): number {
    return this.controllers.size;
  }
}

export const runningJobs = new CancellationRegistry();
