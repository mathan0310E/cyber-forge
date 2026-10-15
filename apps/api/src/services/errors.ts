import { ApiErrorCode } from '@wolf-forge/shared-types';

/**
 * Error type that is safe to serialize to a client. Anything that is not an
 * ApiError is treated as an internal error and its message is withheld.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;
  /** Internal-only context; never serialized to the client. */
  readonly internal?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    opts: {
      status?: number;
      details?: unknown;
      retryable?: boolean;
      internal?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = opts.status ?? defaultStatus(code);
    this.details = opts.details;
    this.retryable = opts.retryable ?? defaultRetryable(code);
    this.internal = opts.internal;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError('bad_request', message, { details });
  }
  static validation(message: string, details?: unknown) {
    return new ApiError('validation_failed', message, { details });
  }
  static unauthorized(message = 'Sign in to continue') {
    return new ApiError('unauthorized', message, { status: 401 });
  }
  static forbidden(message = 'You do not have access to this resource') {
    return new ApiError('forbidden', message, { status: 403 });
  }
  static notFound(message = 'Not found') {
    return new ApiError('not_found', message, { status: 404 });
  }
  static conflict(message: string) {
    return new ApiError('conflict', message, { status: 409 });
  }
  static versionConflict(message: string, details?: unknown) {
    return new ApiError('version_conflict', message, { status: 409, details });
  }
  static tooLarge(message: string) {
    return new ApiError('payload_too_large', message, { status: 413 });
  }
  static rateLimited(message = 'Too many requests. Slow down and try again shortly.') {
    return new ApiError('rate_limited', message, { status: 429, retryable: true });
  }
  static quotaExceeded(message: string, details?: unknown) {
    return new ApiError('quota_exceeded', message, { status: 429, details });
  }
  static notConfigured(message: string, details?: unknown) {
    return new ApiError('provider_not_configured', message, { status: 503, details });
  }
  static buildFailed(message: string, internal?: Record<string, unknown>) {
    return new ApiError('build_failed', message, { status: 502, internal });
  }
  static integrationError(message: string, details?: unknown) {
    return new ApiError('integration_error', message, { status: 502, details });
  }
  static deploymentFailed(message: string, details?: unknown) {
    return new ApiError('deployment_failed', message, { status: 502, details });
  }
  static cancelled(message = 'The build was cancelled') {
    return new ApiError('bad_request', message, { status: 499 });
  }
  static internal(message = 'Something went wrong on our side', internal?: Record<string, unknown>) {
    return new ApiError('internal_error', message, { status: 500, internal });
  }
}

export function cancellationError(): ApiError {
  return ApiError.cancelled();
}

function defaultStatus(code: ApiErrorCode): number {
  switch (code) {
    case 'bad_request':
    case 'validation_failed':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
    case 'version_conflict':
      return 409;
    case 'payload_too_large':
      return 413;
    case 'rate_limited':
    case 'quota_exceeded':
      return 429;
    case 'provider_not_configured':
    case 'sandbox_unavailable':
    case 'not_implemented':
      return 503;
    case 'provider_timeout':
      return 504;
    default:
      return 500;
  }
}

function defaultRetryable(code: ApiErrorCode): boolean {
  return code === 'rate_limited' || code === 'provider_timeout' || code === 'internal_error';
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
