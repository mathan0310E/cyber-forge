import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { ApiError } from '../services/errors.js';

/** Validates and *replaces* req.body with the parsed value. */
export function validateBody<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body ?? {});
      next();
    } catch (e) {
      next(toValidationError(e));
    }
  };
}

/**
 * Validates the query string. Express 4 exposes a mutable `req.query`, so we
 * attach the parsed result to a dedicated property rather than mutating it.
 */
export function validateQuery<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      (req as Request & { validatedQuery?: unknown }).validatedQuery = schema.parse(req.query ?? {});
      next();
    } catch (e) {
      next(toValidationError(e));
    }
  };
}

export function getValidatedQuery<T extends ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const existing = (req as Request & { validatedQuery?: unknown }).validatedQuery;
  return (existing ?? schema.parse(req.query ?? {})) as z.infer<T>;
}

function toValidationError(e: unknown): ApiError {
  if (e instanceof ZodError) {
    const details = e.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    const first = details[0];
    return ApiError.validation(
      first ? `${first.path}: ${first.message}` : 'Request validation failed',
      details,
    );
  }
  return ApiError.badRequest('Invalid request body');
}
