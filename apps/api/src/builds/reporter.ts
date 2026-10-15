import type { BuildJob, BuildState } from '@wolf-forge/shared-types';
import { BuildEventRepository, BuildJobRepository } from './job-store.js';
import { buildEvents } from './event-bus.js';
import { childLogger } from '../services/logger.js';
import { redact } from '../services/redact.js';

/**
 * Reports build progress.
 *
 * Every method writes a persisted event AND publishes it to the in-process bus.
 * The persisted event is the source of truth for SSE replay; the bus is only a
 * latency optimisation. Progress values come from completed stages, never from
 * a timer.
 */
export class BuildReporter {
  private seq = 0;

  constructor(
    private readonly jobId: string,
    private readonly jobs: BuildJobRepository,
    private readonly events: BuildEventRepository,
  ) {}

  async state(to: BuildState, message: string, progress: number, patch: Partial<BuildJob> = {}): Promise<void> {
    const job = await this.jobs.transition(this.jobId, to, { progress, ...patch });
    await this.emit('state', job.state, message, { progress });
  }

  async log(message: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.emit('log', await this.currentState(), redact(message, 2_000), data);
  }

  async progress(progress: number, message: string): Promise<void> {
    await this.jobs.update(this.jobId, { progress });
    await this.emit('progress', await this.currentState(), message, { progress });
  }

  async fileWritten(path: string, bytes: number): Promise<void> {
    await this.emit('file-written', await this.currentState(), `Wrote ${path}`, { path, bytes });
  }

  async diagnostic(severity: string, message: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.emit('diagnostic', await this.currentState(), message, { severity, ...extra });
  }

  async modelSelected(provider: string, model: string, role: string): Promise<void> {
    await this.emit('model-selected', await this.currentState(), `Using ${model} for ${role}`, {
      provider,
      model,
      role,
    });
  }

  async error(message: string, code: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.emit('error', await this.currentState(), redact(message, 1_000), { code, ...data });
  }

  async previewReady(url: string): Promise<void> {
    await this.emit('preview-ready', await this.currentState(), 'Preview is live', { url });
  }

  async usage(data: Record<string, unknown>): Promise<void> {
    await this.emit('usage', await this.currentState(), 'Usage recorded', data);
  }

  private async currentState(): Promise<BuildState> {
    const job = await this.jobs.get(this.jobId);
    return job?.state ?? 'Queued';
  }

  private async emit(
    type: Parameters<BuildEventRepository['append']>[0]['type'],
    state: BuildState,
    message: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const event = await this.events.append({
      jobId: this.jobId,
      type,
      state,
      message,
      data,
    });
    this.seq = event.seq;
    buildEvents.publish(event);
    childLogger({ jobId: this.jobId, seq: event.seq }).debug({ type, state }, message);
  }

  get lastSeq(): number {
    return this.seq;
  }
}

/** Stage → progress mapping used to keep the progress bar honest. */
export const STAGE_PROGRESS: Record<BuildState, number> = {
  Queued: 0.01,
  Analyzing: 0.06,
  Planning: 0.14,
  Generating: 0.42,
  Installing: 0.58,
  Building: 0.74,
  Repairing: 0.8,
  StartingPreview: 0.94,
  PreviewReady: 1,
  Deploying: 0.97,
  Deployed: 1,
  Failed: 1,
  Cancelled: 1,
};
