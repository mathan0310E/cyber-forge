import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@wolf-forge/shared-types';
import { ApiError } from '../services/errors.js';
import type { AuthDriver } from '../services/auth-driver.js';
import type { UserRepository } from '../services/users.js';
import type { Config } from '../config/env.js';

export interface AuthContext {
  driver: AuthDriver;
  users: UserRepository;
  config: Config;
  /** UIDs that are always treated as admins, from trusted configuration. */
  adminUids: ReadonlySet<string>;
}

export function createAuthMiddleware(ctx: AuthContext) {
  /**
   * Authenticates the bearer token and resolves the *authoritative* role from
   * server-side state. A token claim can never grant admin.
   */
  return async function requireAuth(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const header = req.header('authorization') ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (!match) throw ApiError.unauthorized('Missing bearer token');
      const token = match[1]!.trim();
      if (token.length === 0 || token.length > 8192) {
        throw ApiError.unauthorized('Malformed bearer token');
      }

      const principal = await ctx.driver.verify(token);

      let role: UserRole = 'user';
      if (ctx.adminUids.has(principal.user.uid)) {
        role = 'admin';
      } else {
        const record = await ctx.users.getById(principal.user.uid);
        role = record?.role === 'admin' ? 'admin' : 'user';
      }
      principal.user.role = role;
      req.principal = principal;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.principal) return next(ApiError.unauthorized());
  if (req.principal.user.role !== 'admin') {
    return next(ApiError.forbidden('Administrator privileges are required'));
  }
  next();
}

export function getPrincipal(req: Request) {
  if (!req.principal) throw ApiError.unauthorized();
  return req.principal;
}
