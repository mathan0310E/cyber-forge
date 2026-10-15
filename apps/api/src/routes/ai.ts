import type { Router } from 'express';
import { Router as expressRouter } from 'express';
import { z } from 'zod';
import type { UsageRecord } from '@wolf-forge/shared-types';
import type { Config } from '../config/env.js';
import { COLLECTIONS, type DocStore, type WhereClause } from '../db/store.js';
import type { AiServices } from '../ai/config-service.js';
import type { UsageService } from '../usage/service.js';
import type { AuditService } from '../audit/service.js';
import { ApiError } from '../services/errors.js';
import type { ProviderAdapter } from '../providers/types.js';

export interface AiRouteDeps {
  config: Config;
  store: DocStore;
  services: AiServices;
  usage: UsageService;
  audit: AuditService;
  projectsCount?: () => Promise<number>;
}

async function countProjects(deps: AiRouteDeps): Promise<number> {
  return deps.projectsCount?.() ?? 0;
}

const TestRequestBody = z.object({
  model: z.string().min(1).max(200).optional(),
});

export function createAiRouter(deps: AiRouteDeps): Router {
  const router = expressRouter();

  /** GET /api/v1/ai/models */
  router.get('/models', (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const snapshot = deps.services.registry.snapshot();
      type SnapshotModel = (typeof snapshot.models)[number];
      res.json(
        snapshot.models.map((m: SnapshotModel) => ({
          id: m.id,
          modelId: m.modelId,
          provider: m.provider,
          displayName: m.displayName,
          roles: m.roles,
          enabled: m.enabled,
          eligibility: m.eligibility,
          blockedReason: m.blockedReason,
          contextLength: m.contextLength,
          maxOutputTokens: m.maxOutputTokens,
          promptPricePerMillion: m.promptPricePerMillion,
          completionPricePerMillion: m.completionPricePerMillion,
          health: m.health,
          lastCheckedAt: m.lastCheckedAt,
          lastSuccessAt: m.lastSuccessAt,
          failureCount: m.failureCount,
          timeoutMs: m.timeoutMs,
          capabilities: m.capabilities,
          isCustom: m.isCustom,
        })),
      );
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/ai/providers */
  router.get('/providers', (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const providers = deps.services.providers;
      const providerStatus = [...providers.values()].map((adapter: ProviderAdapter) => ({
        id: adapter.id,
        label: adapter.label,
        configured: adapter.isConfigured(),
        setupHint: adapter.setupHint(),
        enabled: adapter.isConfigured(),
        health: adapter.isConfigured() ? 'unknown' : 'unavailable',
        lastCheckedAt: null,
        detail: null,
      }));
      res.json({ freeOnly: deps.services.registry.freeOnly, providers: providerStatus });
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/ai/providers/:provider/test */
  router.post('/providers/:provider/test', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const { provider } = req.params;
      const adapter = deps.services.providers.get(provider as never);
      if (!adapter) throw ApiError.notFound(`Unknown provider "${provider}".`);
      if (!adapter.isConfigured()) {
        throw ApiError.notConfigured(adapter.setupHint());
      }
      const { model } = TestRequestBody.parse(req.body ?? {});
      const health = await adapter.healthCheck();
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'ai.providerTest',
        resourceType: 'provider',
        resourceId: adapter.id,
        outcome: health.ok ? 'success' : 'failure',
        metadata: { latencyMs: health.latencyMs, sampleModelCount: health.sampleModels.length },
      });
      res.json({
        provider: adapter.id,
        ok: health.ok,
        message: health.message,
        latencyMs: health.latencyMs,
        sampleModels: health.sampleModels,
        requestedModel: model ?? null,
      });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/ai/usage */
  router.get('/usage', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const summary = await deps.usage.summaryForUser(p.user.uid, {
        totalProjects: await countProjects(deps),
      });
      const since = (req.query.since as string | undefined) ?? null;
      const where: WhereClause[] = [
        { field: 'userId', op: '==', value: p.user.uid },
      ];
      if (typeof since === 'string' && since.length > 0) {
        where.push({ field: 'createdAt', op: '>', value: since });
      }
      const recent = await deps.store.query<UsageRecord>(COLLECTIONS.usage, {
        where,
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
        limit: 50,
      });
      res.json({
        limits: {
          dailyBuilds: deps.usage.limits.dailyBuilds,
          concurrentBuilds: deps.usage.limits.maxConcurrentBuilds,
          maxPromptChars: deps.usage.limits.maxPromptChars,
          maxFilesPerProject: deps.usage.limits.maxFilesPerProject,
          maxSourceBytes: deps.usage.limits.maxSourceBytes,
          maxOutputTokens: deps.usage.limits.maxOutputTokens,
        },
        summary,
        recent: recent.items,
      });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/ai/config — full (non-secret) configuration snapshot. */
  router.get('/config', (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      res.json({
        freeOnly: deps.services.registry.freeOnly,
        models: deps.services.registry.snapshot().models,
        catalogSource: deps.services.registry.lastFetch.source,
        lastFetchAt: deps.services.registry.lastFetch.at,
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}