import { z } from 'zod';

export const QuotaLimitsSchema = z.object({
  maxConcurrentBuilds: z.number().int().positive(),
  maxRepairAttempts: z.number().int().nonnegative(),
  maxBuildDurationMs: z.number().int().positive(),
  maxPromptChars: z.number().int().positive(),
  maxFilesPerProject: z.number().int().positive(),
  maxSourceBytes: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  dailyBuilds: z.number().int().positive(),
  requestsPerMinute: z.number().int().positive(),
});
export type QuotaLimits = z.infer<typeof QuotaLimitsSchema>;

export const UsageSummarySchema = z.object({
  limits: QuotaLimitsSchema,
  buildsToday: z.number().int().nonnegative(),
  buildsRemainingToday: z.number().int().nonnegative(),
  activeBuilds: z.number().int().nonnegative(),
  totalBuilds: z.number().int().nonnegative(),
  totalProjects: z.number().int().nonnegative(),
  totalSourceBytes: z.number().int().nonnegative(),
  /** Only counted when the provider reported usage. */
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  dispatches: z.number().int().nonnegative(),
  failedDispatches: z.number().int().nonnegative(),
  /** Null when no dispatch reported reliable pricing. */
  estimatedCostUsd: z.number().nonnegative().nullable(),
  periodStart: z.string(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const UsageRecordSchema = z.object({
  id: z.string(),
  userId: z.string(),
  projectId: z.string().nullable(),
  jobId: z.string().nullable(),
  kind: z.enum(['build', 'ai-dispatch']),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  role: z.string().nullable(),
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative().nullable(),
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  createdAt: z.string(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const AuditLogSchema = z.object({
  id: z.string(),
  actorUid: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  outcome: z.enum(['success', 'failure', 'denied']),
  /** Redacted metadata only — never tokens, prompts or file bodies. */
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;
