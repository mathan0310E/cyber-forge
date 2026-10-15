import type { BuildJob } from '@wolf-forge/shared-types';
import { runningJobs } from './event-bus.js';
import { GenerationPipeline, type PipelineDeps } from './pipeline.js';
import { childLogger } from '../services/logger.js';
import { UsageService } from '../usage/service.js';

/**
 * Executes a build job with a fresh AbortController so the job can be cancelled
 * independently of any HTTP request. A job is given a bounded wall-clock budget
 * derived from server quotas; exceeding it fails the job rather than hanging.
 */
export class BuildRunner {
  constructor(private readonly pipeline: GenerationPipeline, private readonly usage: UsageService) {}

  /** Access to the pipeline deps for job updates. */
  get deps(): PipelineDeps {
    return this.pipeline.deps;
  }

  async execute(job: BuildJob): Promise<void> {
    const log = childLogger({ jobId: job.id, runner: 'main' });
    const startedAt = Date.now();

    const controller = new AbortController();
    runningJobs.register(job.id);

    const deadline = setTimeout(() => {
      log.warn({ elapsedMs: Date.now() - startedAt }, 'build exceeded the wall-clock budget');
      controller.abort(new Error('build-duration-budget-exceeded'));
    }, this.usage.limits.maxBuildDurationMs);
    deadline.unref?.();

    const started = new Date().toISOString();
    await this.pipeline.deps.jobs.update(job.id, {
      startedAt: started,
      workerId: `main:${process.pid}`,
    });

    try {
      const result = await this.pipeline.run(job, controller.signal);
      await this.usage.recordBuild({
        userId: job.ownerUid,
        projectId: job.projectId,
        jobId: job.id,
        ok: result.versionId !== null && result.previewUrl !== null,
        durationMs: Date.now() - startedAt,
      });
      log.info(
        { resultVersionId: result.versionId, previewUrl: result.previewUrl },
        'build finished',
      );
    } catch (e) {
      log.error({ err: String(e) }, 'runner encountered an error');
    } finally {
      clearTimeout(deadline);
      runningJobs.release(job.id);
    }
  }
}