import { z } from 'zod';

/** Stable machine-readable error codes returned by the API. */
export const ApiErrorCode = z.enum([
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'version_conflict',
  'payload_too_large',
  'rate_limited',
  'quota_exceeded',
  'provider_not_configured',
  'provider_error',
  'provider_timeout',
  'no_eligible_model',
  'free_only_violation',
  'build_failed',
  'sandbox_unavailable',
  'deployment_failed',
  'integration_error',
  'not_implemented',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCode,
  message: z.string(),
  /** Field-level details for validation failures. Never contains secrets. */
  details: z.unknown().optional(),
  requestId: z.string().optional(),
  /** True when retrying the same request could plausibly succeed. */
  retryable: z.boolean().default(false),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorEnvelopeSchema = z.object({ error: ApiErrorSchema });
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), pageInfo: PageInfoSchema });
}

/** Roles are decided by trusted server-side authorization only. */
export const UserRole = z.enum(['user', 'admin']);
export type UserRole = z.infer<typeof UserRole>;

export const HEALTH_STATUSES = ['ok', 'degraded', 'unconfigured'] as const;
export const HealthStatus = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof HealthStatus>;
