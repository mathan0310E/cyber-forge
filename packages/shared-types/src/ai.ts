import { z } from 'zod';

/** Task roles the routing engine can dispatch. */
export const AiTaskRole = z.enum([
  'planner',
  'codegen',
  'ui-refine',
  'debug',
  'review',
  'fallback',
]);
export type AiTaskRole = z.infer<typeof AiTaskRole>;

export const AiProviderId = z.enum(['openrouter', 'gemini', 'ollama']);
export type AiProviderId = z.infer<typeof AiProviderId>;

export const AI_TASK_LABELS: Record<AiTaskRole, string> = {
  planner: 'Planner',
  codegen: 'Code generation',
  'ui-refine': 'UI refinement',
  debug: 'Debugging',
  review: 'Review',
  fallback: 'Fallback',
};

export const AI_TASK_DESCRIPTIONS: Record<AiTaskRole, string> = {
  planner: 'Turns a natural-language brief into a structured website specification.',
  codegen: 'Writes project source files and targeted patches.',
  'ui-refine': 'Handles layout, typography, component styling and responsive behaviour.',
  debug: 'Reads compiler output and produces a minimal fix.',
  review: 'Checks generated changes for consistency and likely defects.',
  fallback: 'Picks up eligible work when the assigned model is unavailable.',
};

/** Capabilities a model must advertise to be eligible for a task. */
export const ModelCapability = z.enum([
  'chat',
  'streaming',
  'json-mode',
  'tool-calling',
  'long-context',
]);
export type ModelCapability = z.infer<typeof ModelCapability>;

export const FREE_ELIGIBILITY = [
  /** Provider metadata reports a zero price for prompt and completion. */
  'verified-free',
  /** Provider exposes no pricing for this model. Blocked in strict free-only mode. */
  'unknown',
  /** Provider reports a non-zero price. Always blocked. */
  'paid',
] as const;
export const FreeEligibility = z.enum(FREE_ELIGIBILITY);
export type FreeEligibility = z.infer<typeof FreeEligibility>;

export const ModelHealth = z.enum(['unknown', 'healthy', 'degraded', 'unavailable']);
export type ModelHealth = z.infer<typeof ModelHealth>;

export const AiModelSchema = z.object({
  id: z.string(),
  provider: AiProviderId,
  /** Provider-native model identifier, e.g. `meta-llama/llama-3.3-70b-instruct:free`. */
  modelId: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  capabilities: z.array(ModelCapability),
  eligibility: FreeEligibility,
  /** Null when the provider does not expose a context window. */
  contextLength: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  /** Roles this model may be assigned to. */
  roles: z.array(AiTaskRole),
  health: ModelHealth,
  lastCheckedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  failureCount: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive(),
  /** Pricing as reported by the provider, per million tokens. Null when unknown. */
  promptPricePerMillion: z.number().nullable(),
  completionPricePerMillion: z.number().nullable(),
  /** Human-readable reason this model is currently blocked, if any. */
  blockedReason: z.string().nullable(),
  isCustom: z.boolean(),
});
export type AiModel = z.infer<typeof AiModelSchema>;

export const AiRoleAssignmentSchema = z.object({
  role: AiTaskRole,
  /** Ordered list of model ids; the first eligible one wins, rest are fallbacks. */
  modelIds: z.array(z.string()),
});
export type AiRoleAssignment = z.infer<typeof AiRoleAssignmentSchema>;

export const AiProviderStatusSchema = z.object({
  id: AiProviderId,
  label: z.string(),
  configured: z.boolean(),
  enabled: z.boolean(),
  /** Safe, human-readable description of what is missing. Never echoes the key. */
  setupHint: z.string(),
  /** Result of the most recent health probe, if one has been run. */
  health: ModelHealth,
  lastCheckedAt: z.string().nullable(),
  detail: z.string().nullable(),
});
export type AiProviderStatus = z.infer<typeof AiProviderStatusSchema>;

export const AiConfigSchema = z.object({
  freeOnly: z.boolean(),
  providers: z.array(AiProviderStatusSchema),
  assignments: z.array(AiRoleAssignmentSchema),
  models: z.array(AiModelSchema),
  catalogFetchedAt: z.string().nullable(),
  catalogSource: z.enum(['live', 'cache', 'builtin']),
});
export type AiConfig = z.infer<typeof AiConfigSchema>;

export const UpdateAiConfigRequestSchema = z.object({
  freeOnly: z.boolean().optional(),
  assignments: z
    .array(
      z.object({
        role: AiTaskRole,
        modelIds: z.array(z.string()).max(8),
      }),
    )
    .optional(),
  modelOverrides: z
    .array(
      z.object({
        id: z.string(),
        enabled: z.boolean().optional(),
        roles: z.array(AiTaskRole).optional(),
      }),
    )
    .optional(),
});
export type UpdateAiConfigRequest = z.infer<typeof UpdateAiConfigRequestSchema>;

export const ProviderTestResultSchema = z.object({
  provider: AiProviderId,
  ok: z.boolean(),
  message: z.string(),
  /** Round-trip latency of the probe, when it completed. */
  latencyMs: z.number().int().nonnegative().nullable(),
  /** Model ids the provider reported, capped for display. */
  sampleModels: z.array(z.string()).default([]),
  checkedAt: z.string(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

/** Records one model dispatch. Written for every AI call, success or failure. */
export const AiDispatchRecordSchema = z.object({
  id: z.string(),
  userId: z.string(),
  projectId: z.string().nullable(),
  jobId: z.string().nullable(),
  role: AiTaskRole,
  provider: AiProviderId,
  model: z.string(),
  startedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  ok: z.boolean(),
  attempt: z.number().int().positive(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  /** Only set when the provider returned reliable pricing. */
  estimatedCostUsd: z.number().nonnegative().nullable(),
  errorCode: z.string().nullable(),
  providerRequestId: z.string().nullable(),
});
export type AiDispatchRecord = z.infer<typeof AiDispatchRecordSchema>;
