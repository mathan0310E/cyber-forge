import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { ApiError } from '../services/errors.js';

/**
 * Rate limiters. Keys are derived from the authenticated user when available so
 * that one user cannot exhaust a shared IP bucket for everyone behind a proxy.
 */
function keyFor(req: Request): string {
  if (req.principal?.user.uid) return `u:${req.principal.user.uid}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

function handler(_req: Request, res: Response): void {
  const err = ApiError.rateLimited();
  res.status(err.status).json({ error: err.toJSON() });
}

export function createRateLimiters(requestsPerMinute: number, disabled: boolean) {
  const base: Partial<Options> = {
    windowMs: 60_000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyFor,
    handler,
    // Disabled in tests so suites are deterministic.
    skip: () => disabled,
  };

  return {
    /** Applied to the whole /api surface. */
    general: rateLimit({ ...base, limit: requestsPerMinute }),
    /** Expensive endpoints: builds, provider tests, exports, deployments. */
    expensive: rateLimit({ ...base, limit: Math.max(5, Math.floor(requestsPerMinute / 4)) }),
    /** Credential endpoints, keyed by IP regardless of principal. */
    credentials: rateLimit({
      ...base,
      limit: 10,
      keyGenerator: (req: Request) => `ip:${req.ip ?? 'unknown'}`,
    }),
  };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;
