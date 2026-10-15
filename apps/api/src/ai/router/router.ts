import type { AiDispatchRecord, AiTaskRole, ModelCapability } from '@wolf-forge/shared-types';
import { ApiError } from '../../services/errors.js';
import { childLogger } from '../../services/logger.js';
import { redact } from '../../services/redact.js';
import { ProviderError, type ChatMessage } from '../../providers/types.js';
import type { ModelRegistry } from './registry.js';

export interface DispatchRequest {
  role: AiTaskRole;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
  /** Capabilities the chosen model must advertise. */
  requires?: ModelCapability[];
  /**
   * Per-attempt timeout multiplier is not used; each model carries its own
   * timeout so slow codegen models are not cut off at a planner's deadline.
   */
  signal?: AbortSignal;
  /** Hard ceiling on attempts across all candidate models. */
  maxAttempts?: number;
}

export interface DispatchContext {
  userId: string;
  projectId: string | null;
  jobId: string | null;
}

export interface DispatchSuccess {
  text: string;
  modelId: string;
  providerId: string;
  providerRequestId: string | null;
  finishReason: string | null;
  attempts: number;
  records: AiDispatchRecord[];
}

export type DispatchRecorder = (record: AiDispatchRecord) => Promise<void>;

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Policy-based model router.
 *
 * Flow per request:
 *   1. classify the task and derive capability requirements,
 *   2. ask the registry for eligible models in preference order (free-only and
 *      pricing checks already applied there),
 *   3. dispatch, honouring cancellation and per-model timeouts,
 *   4. record provider, model, duration, usage and outcome for every attempt,
 *   5. on a *retryable* failure move to the next candidate, up to a bounded
 *      budget; on a permanent failure (bad key, 400, paid model) stop at once,
 *   6. if everything fails, return one actionable error that names what was tried.
 */
export class ModelRouter {
  constructor(
    private readonly registry_: ModelRegistry,
    private readonly record: DispatchRecorder,
  ) {}

  /** Exposes the registry to stages that need to probe eligibility. */
  registry(): ModelRegistry {
    return this.registry_;
  }

  async dispatch(request: DispatchRequest, context: DispatchContext): Promise<DispatchSuccess> {
    const candidates = this.registry_.eligibleForRole(request.role, request.requires ?? []);
    if (candidates.length === 0) {
      // Produces the precise "no eligible model" / free-only violation error.
      this.registry_.requireEligible(request.role, request.requires ?? []);
      throw ApiError.internal('unreachable: requireEligible did not throw');
    }

    const maxAttempts = Math.min(
      request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      candidates.length,
    );
    const records: AiDispatchRecord[] = [];
    const failures: Array<{ model: string; reason: string; retryable: boolean }> = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (request.signal?.aborted) {
        throw new ApiError('internal_error', 'Generation was cancelled.', { status: 499 });
      }

      const candidate = candidates[attempt - 1]!;
      const { model, provider } = candidate;
      const log = childLogger({
        role: request.role,
        model: model.id,
        attempt,
        jobId: context.jobId,
      });

      const startedAt = Date.now();
      try {
        log.info({ timeoutMs: model.timeoutMs }, 'dispatching to model');
        const response = await provider.chat({
          model: model.modelId,
          messages: request.messages,
          maxTokens: request.maxTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.jsonMode !== undefined ? { jsonMode: request.jsonMode } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          timeoutMs: model.timeoutMs,
        });

        const durationMs = Date.now() - startedAt;
        this.registry_.recordOutcome(model.id, { ok: true });

        const record: AiDispatchRecord = {
          id: `${model.id}:${startedAt}`,
          userId: context.userId,
          projectId: context.projectId,
          jobId: context.jobId,
          role: request.role,
          provider: model.provider,
          model: model.modelId,
          startedAt: new Date(startedAt).toISOString(),
          durationMs,
          ok: true,
          attempt,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          estimatedCostUsd: response.usage.costUsd,
          errorCode: null,
          providerRequestId: response.providerRequestId,
        };
        records.push(record);
        await this.record(record);

        log.info({ durationMs, chars: response.text.length }, 'model dispatch succeeded');
        return {
          text: response.text,
          modelId: model.modelId,
          providerId: model.provider,
          providerRequestId: response.providerRequestId,
          finishReason: response.finishReason,
          attempts: attempt,
          records,
        };
      } catch (e) {
        const durationMs = Date.now() - startedAt;
        const normalized = normalizeFailure(e);

        this.registry_.recordOutcome(model.id, {
          ok: false,
          errorCode: normalized.kind,
        });

        const record: AiDispatchRecord = {
          id: `${model.id}:${startedAt}`,
          userId: context.userId,
          projectId: context.projectId,
          jobId: context.jobId,
          role: request.role,
          provider: model.provider,
          model: model.modelId,
          startedAt: new Date(startedAt).toISOString(),
          durationMs,
          ok: false,
          attempt,
          promptTokens: null,
          completionTokens: null,
          estimatedCostUsd: null,
          errorCode: normalized.kind,
          providerRequestId: normalized.providerRequestId ?? null,
        };
        records.push(record);
        await this.record(record);

        failures.push({
          model: model.id,
          reason: normalized.message,
          retryable: normalized.retryable,
        });

        // Cancellation is not a model failure: surface it immediately.
        if (normalized.kind === 'cancelled') {
          throw new ApiError('internal_error', 'Generation was cancelled.', { status: 499 });
        }

        log.warn(
          { durationMs, kind: normalized.kind, retryable: normalized.retryable },
          'model dispatch failed',
        );

        // Permanent failures are not retried against other models when they are
        // configuration problems (bad credentials) — retrying only burns time.
        if (normalized.kind === 'unauthorized' || normalized.kind === 'forbidden') {
          throw ApiError.notConfigured(
            `${model.provider} rejected the server's credentials, so generation cannot continue. ${normalized.message}`,
            { provider: model.provider },
          );
        }

        if (!normalized.retryable && attempt >= 1) {
          // Continue to the next candidate only if the failure was model-specific
          // (e.g. this model is unavailable); otherwise stop.
          if (normalized.kind !== 'model_unavailable' && normalized.kind !== 'bad_request') {
            throw toApiError(normalized, failures);
          }
        }
      }
    }

    throw toApiError(null, failures);
  }
}

function normalizeFailure(
  e: unknown,
): { kind: string; message: string; retryable: boolean; providerRequestId?: string | null } {
  if (e instanceof ProviderError) {
    return {
      kind: e.kind,
      message: e.message,
      retryable: e.retryable,
      providerRequestId: e.providerRequestId ?? null,
    };
  }
  if (e instanceof ApiError) {
    return { kind: e.code, message: e.message, retryable: e.retryable };
  }
  return {
    kind: 'unknown',
    message: redact(e instanceof Error ? e.message : String(e), 400),
    retryable: true,
  };
}

function toApiError(
  last: { kind: string; message: string; retryable: boolean } | null,
  failures: Array<{ model: string; reason: string; retryable: boolean }>,
): ApiError {
  const tried = failures.map((f) => `${f.model} (${f.reason})`).join('; ');
  const anyRetryable = failures.some((f) => f.retryable);

  if (failures.some((f) => f.reason.includes('rate-limit'))) {
    return new ApiError(
      'provider_error',
      `Every eligible model was rate-limited. ${failures.length} model(s) tried. Free tiers have ` +
        'shared rate limits; wait a moment and retry, or add a second provider.',
      { status: 429, retryable: true, details: { tried: failures } },
    );
  }

  return new ApiError(
    'provider_error',
    `All ${failures.length} eligible model(s) failed for this task. Details: ${redact(tried, 800)}`,
    {
      status: 502,
      retryable: anyRetryable || last === null,
      details: { tried: failures },
    },
  );
}
