import type { RequestHandler, Router } from 'express';
import { Router as expressRouter } from 'express';
import { CreateBuildRequestSchema, type BuildEvent } from '@wolf-forge/shared-types';
import type { Config } from '../config/env.js';
import type { ProjectRepository } from '../projects/repository.js';
import type {
  BuildEventRepository,
  BuildJobRepository,
} from '../builds/job-store.js';
import type { BuildRunner } from '../builds/runner.js';
import type { UsageService } from '../usage/service.js';
import { buildEvents, runningJobs } from '../builds/event-bus.js';
import { ApiError } from '../services/errors.js';

export interface BuildDeps {
  config: Config;
  projects: ProjectRepository;
  jobs: BuildJobRepository;
  events: BuildEventRepository;
  runner: BuildRunner;
  usage: UsageService;
}

/** Shared handler for POST /projects/:projectId/builds (used by both mounts). */
function createBuildRequestHandler(deps: BuildDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();

      const projectId = req.params.projectId;
      if (!projectId) throw ApiError.badRequest('Missing project id.');
      const input = CreateBuildRequestSchema.parse(req.body ?? {});
      const project = await deps.projects.getOwned(projectId, p.user.uid);

      // Quotas are enforced server-side from configuration (never client-side).
      if (input.instruction && input.instruction.length > deps.config.quotas.maxPromptChars) {
        throw ApiError.quotaExceeded(
          `Instruction exceeds the ${deps.config.quotas.maxPromptChars}-character limit.`,
        );
      }
      const quota = await deps.usage.canStartBuild(p.user.uid);
      if (!quota.ok) throw ApiError.quotaExceeded(quota.reason);

      const baseVersionId = input.baseVersionId ?? project.currentVersionId;

      const job = await deps.jobs.create({
        projectId,
        ownerUid: p.user.uid,
        operation: input.operation,
        instruction: input.instruction ?? null,
        baseVersionId,
        maxRepairAttempts: deps.config.quotas.maxRepairAttempts,
      });

      // Fire-and-forget: the runner owns the rest of the lifecycle.
      void deps.runner.execute(job);

      res.status(202).json({ job });
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Spec-compatible mount: exposes POST /projects/:projectId/builds under
 * /api/v1/projects without shadowing project routes (no catch-all here).
 */
export function createProjectBuildsAliasRouter(deps: BuildDeps): Router {
  const router = expressRouter();
  router.post('/:projectId/builds', createBuildRequestHandler(deps));
  return router;
}

export function createBuildsRouter(deps: BuildDeps): Router {
  const router = expressRouter();

  /** POST /api/v1/projects/:projectId/builds (spec path, also aliased below for the /api/v1/builds mount) */
  router.post('/projects/:projectId/builds', createBuildRequestHandler(deps));

  /** GET /api/v1/builds/:buildId */
  router.get('/:buildId', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const job = await deps.jobs.getOwned(req.params.buildId, p.user.uid);
      res.json(job);
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/builds/:buildId/cancel */
  router.post('/:buildId/cancel', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const job = await deps.jobs.getOwned(req.params.buildId, p.user.uid);
      await deps.jobs.requestCancel(job.id);
      runningJobs.cancel(job.id);
      res.json({
        ok: true,
        jobId: job.id,
        message: 'Cancellation requested. The worker stops at its next safe point.',
      });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/builds/:buildId/events — SSE stream or replay. */
  router.get('/:buildId/events', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const job = await deps.jobs.getOwned(req.params.buildId, p.user.uid);

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const writeEvent = (type: string, payload: unknown) => {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      writeEvent('hello', { jobId: job.id, state: job.state });

      const sinceSeq = Number(req.query.since ?? 0);
      const events = await deps.events.listSince(job.id, sinceSeq, 20_000);
      events.forEach((e) => {
        writeEvent('build-event', {
          id: e.id,
          seq: e.seq,
          type: e.type,
          state: e.state,
          message: e.message,
          data: e.data,
          at: e.at,
        });
      });

      const subscriber: (event: BuildEvent) => void = (event) => {
        writeEvent('build-event', {
          id: event.id,
          seq: event.seq,
          type: event.type,
          state: event.state,
          message: event.message,
          data: event.data,
          at: event.at,
        });
      };
      const unsubscribe = buildEvents.subscribe(job.id, subscriber);

      const heartbeat = setInterval(() => {
        res.write(': keep-alive\n\n');
      }, 20_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}