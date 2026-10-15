import type { NextFunction, Request, Response } from 'express';
import { ApiError, isApiError } from '../services/errors.js';
import { logger } from '../services/logger.js';
import { redact } from '../services/redact.js';

/**
 * Terminal error handler.
 *
 * Known ApiErrors are serialized as-is. Everything else is logged with full
 * detail and reported to the client as a generic internal error, so stack
 * traces, provider payloads and credentials never reach the browser.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.requestId ?? 'unknown';

  if (isApiError(err)) {
    if (err.status >= 500) {
      logger().error(
        { requestId, code: err.code, internal: err.internal, path: req.path },
        err.message,
      );
    } else {
      logger().info(
        { requestId, code: err.code, status: err.status, path: req.path },
        err.message,
      );
    }
    res.status(err.status).json({
      error: { ...err.toJSON(), requestId },
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  logger().error(
    {
      requestId,
      path: req.path,
      method: req.method,
      err: redact(err instanceof Error ? (err.stack ?? message) : message, 4000),
    },
    'unhandled error',
  );

  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side. The request ID is shown for support.',
      retryable: true,
      requestId,
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  const err = ApiError.notFound(`No route matches ${req.method} ${req.path}`);
  res.status(404).json({ error: { ...err.toJSON(), requestId: req.requestId } });
}

/** Wraps an async handler so rejected promises reach the error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
