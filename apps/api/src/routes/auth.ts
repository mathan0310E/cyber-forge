import crypto from 'node:crypto';
import type { Router } from 'express';
import { Router as expressRouter } from 'express';
import type { SessionUser } from '@wolf-forge/shared-types';
import {
  LoginRequestSchema,
  PasswordResetRequestSchema,
  SignupRequestSchema,
  UpdateProfileRequestSchema,
} from '@wolf-forge/shared-types';
import type { Config } from '../config/env.js';
import type { DocStore } from '../db/store.js';
import type { AuthDriver } from '../services/auth-driver.js';
import type { RequestHandler } from 'express';
import { ApiError } from '../services/errors.js';
import { hashPassword, verifyPassword } from '../services/password.js';
import type { UserRepository } from '../services/users.js';
import type { AuditService } from '../audit/service.js';

function newUid(): string {
  return `usr_${crypto.randomBytes(12).toString('hex')}`;
}

export interface AuthRouteDeps {
  config: Config;
  driver: AuthDriver;
  users: UserRepository;
  store: DocStore;
  audit: AuditService;
  /** Bearer-token gate for the private /me endpoint. */
  requireAuth: RequestHandler;
}

export function createAuthRouter(deps: AuthRouteDeps): Router {
  const router = expressRouter();
  const { driver, users, audit, requireAuth } = deps;
  const localCredentials = driver.id === 'local';

  /** /api/v1/auth/signup */
  router.post('/signup', async (req, res, next) => {
    try {
      if (!deps.config.env.WOLF_FORGE_ALLOW_LOCAL_AUTH_IN_PROD && deps.config.isProduction) {
        throw ApiError.forbidden(
          'Sign-up via the built-in email driver is disabled in production. Configure Firebase Authentication.',
        );
      }

      const input = SignupRequestSchema.parse(req.body ?? {});
      const email = input.email.toLowerCase().trim();

      const existing = await users.getByEmail(email);
      if (existing) {
        throw ApiError.conflict('An account with this email already exists. Sign in instead.');
      }

      const { hash, salt } = await hashPassword(input.password);
      const uid = newUid();
      await users.create({
        uid,
        email,
        displayName: input.displayName ?? email.split('@')[0] ?? null,
        emailVerified: false,
        role: 'user',
        passwordHash: hash,
        passwordSalt: salt,
      });

      const record = await users.getById(uid);
      if (!record) throw ApiError.internal('Account created but could not be loaded.');
      const user = users.toSessionUser(record);
      const session = issueSession(driver, user);

      await audit.record({
        actorUid: uid,
        action: 'auth.signup',
        resourceType: 'user',
        resourceId: uid,
        outcome: 'success',
      });

      res.status(201).json({ user, token: session.token, expiresAt: session.expiresAt, driver: driver.id });
    } catch (e) {
      next(e);
    }
  });

  /** /api/v1/auth/login */
  router.post('/login', async (req, res, next) => {
    try {
      const input = LoginRequestSchema.parse(req.body ?? {});
      const email = input.email.toLowerCase().trim();
      const record = await users.getByEmail(email);
      if (!record) {
        // Constant-time-ish negative path; do not reveal whether the email exists.
        await verifyPassword(input.password, null, null);
        throw ApiError.unauthorized('Email or password is incorrect.');
      }

      const ok = await verifyPassword(input.password, record.passwordHash, record.passwordSalt);
      if (!ok) throw ApiError.unauthorized('Email or password is incorrect.');

      await users.recordLogin(record.id);
      const user = users.toSessionUser(record);
      const session = issueSession(driver, user);
      await audit.record({
        actorUid: record.id,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: record.id,
        outcome: 'success',
      });
      res.json({ user, token: session.token, expiresAt: session.expiresAt, driver: driver.id });
    } catch (e) {
      next(e);
    }
  });

  /** /api/v1/auth/me — returns the current session user (via requireAuth). */
  router.get('/me', requireAuth, (req, res) => {
    const p = req.principal;
    if (!p) throw ApiError.unauthorized();
    res.json({ user: p.user, driver: p.driver });
  });

  /** /api/v1/auth/password-reset — local driver only; Firebase uses its own flow. */
  router.post('/password-reset', async (req, res, next) => {
    try {
      if (!localCredentials) {
        throw ApiError.notConfigured(
          'Password reset is handled by Firebase Authentication. Use the Firebase console or the SDK flow.',
        );
      }
      const input = PasswordResetRequestSchema.parse(req.body ?? {});
      // The local driver has no outbound email. Respond identically whether or
      // not the account exists. Reset instructions must be added by the operator.
      void input;
      res.json({
        message:
          'If that email belongs to an account in this development driver, an administrator can reset its password.',
      });
    } catch (e) {
      next(e);
    }
  });

  /** /api/v1/auth/profile */
  router.patch('/profile', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const input = UpdateProfileRequestSchema.parse(req.body ?? {});
      const updateUser = p.driver;
      await users.update(p.user.uid, { displayName: input.displayName });
      const record = await users.getById(p.user.uid);
      if (!record) throw ApiError.internal('User record not found.');
      const user = users.toSessionUser(record);
      if (updateUser === 'local') {
        await audit.record({
          actorUid: p.user.uid,
          action: 'auth.updateProfile',
          resourceType: 'user',
          resourceId: p.user.uid,
          outcome: 'success',
        });
      }
      res.json({ user });
    } catch (e) {
      next(e);
    }
  });

  /** /api/v1/auth/delete — full account deletion (local driver). */
  router.delete('/account', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      if (!localCredentials) {
        throw ApiError.notConfigured(
          'Account deletion is handled by Firebase Authentication in Firebase mode.',
        );
      }
      const uid = p.user.uid;
      // Delete owned data recursively via the store's deleteWhere capabilities.
      const collections = [
        'projects',
        'projectVersions',
        'buildJobs',
        'buildEvents',
        'integrations',
        'deployments',
        'usageRecords',
      ] as const;
      for (const c of collections) {
        await deps.store.deleteWhere(c, [{ field: 'ownerUid', op: '==', value: uid }]);
      }
      await deps.store.deleteWhere('integrations', [
        { field: 'account', op: '==', value: uid },
      ]);
      await users.delete(uid);
      await audit.record({
        actorUid: uid,
        action: 'auth.deleteAccount',
        resourceType: 'user',
        resourceId: uid,
        outcome: 'success',
      });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/** Returns a signed session for the local driver; Firebase mode is client-side. */
export function issueSession(
  driver: AuthDriver,
  user: SessionUser,
): { token: string; expiresAt: string } {
  if (driver.id === 'local') {
    return (driver as unknown as { issue(u: SessionUser): { token: string; expiresAt: string } }).issue(
      user,
    );
  }
  throw ApiError.notConfigured(
    'Firebase Authentication issues tokens on the client; server-side session issuance is not supported.',
  );
}