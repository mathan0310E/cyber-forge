import crypto from 'node:crypto';
import type { SessionUser, UserRole } from '@wolf-forge/shared-types';
import type { Config } from '../config/env.js';
import { ApiError } from '../services/errors.js';
import { logger } from '../services/logger.js';

export interface AuthenticatedPrincipal {
  user: SessionUser;
  driver: 'firebase' | 'local';
}

export interface AuthDriver {
  readonly id: 'firebase' | 'local';
  /** Verifies a bearer token. Throws ApiError.unauthorized on any failure. */
  verify(token: string): Promise<AuthenticatedPrincipal>;
}

/* -------------------------------------------------------------------------- */
/* Local driver — real signed sessions, no third-party dependency.            */
/* -------------------------------------------------------------------------- */

interface LocalTokenPayload {
  sub: string;
  email: string | null;
  name: string | null;
  ev: boolean;
  role: UserRole;
  iat: number;
  exp: number;
}

export class LocalAuthDriver implements AuthDriver {
  readonly id = 'local' as const;

  constructor(private readonly secret: string, private readonly ttlSeconds = 60 * 60 * 24 * 7) {
    if (secret.length < 32) {
      throw new Error(
        'WOLF_FORGE_LOCAL_AUTH_SECRET must be at least 32 characters. Generate one with: ' +
          'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
  }

  issue(user: SessionUser): { token: string; expiresAt: string } {
    const now = Math.floor(Date.now() / 1000);
    const payload: LocalTokenPayload = {
      sub: user.uid,
      email: user.email,
      name: user.displayName,
      ev: user.emailVerified,
      role: user.role,
      iat: now,
      exp: now + this.ttlSeconds,
    };
    const body = base64url(JSON.stringify(payload));
    return {
      token: `${body}.${this.sign(body)}`,
      expiresAt: new Date((now + this.ttlSeconds) * 1000).toISOString(),
    };
  }

  private sign(body: string): string {
    return crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  async verify(token: string): Promise<AuthenticatedPrincipal> {
    const parts = token.split('.');
    if (parts.length !== 2) throw ApiError.unauthorized('Malformed session token');
    const [body, signature] = parts as [string, string];
    const expected = this.sign(body);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw ApiError.unauthorized('Invalid session signature');
    }
    let payload: LocalTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LocalTokenPayload;
    } catch {
      throw ApiError.unauthorized('Malformed session payload');
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
      throw ApiError.unauthorized('Session expired. Sign in again.');
    }
    return {
      driver: 'local',
      user: {
        uid: payload.sub,
        email: payload.email ?? null,
        displayName: payload.name ?? null,
        emailVerified: Boolean(payload.ev),
        role: payload.role === 'admin' ? 'admin' : 'user',
        createdAt: new Date(payload.iat * 1000).toISOString(),
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Firebase driver                                                            */
/* -------------------------------------------------------------------------- */

export class FirebaseAuthDriver implements AuthDriver {
  readonly id = 'firebase' as const;

  async verify(token: string): Promise<AuthenticatedPrincipal> {
    const { getAuth } = await import('firebase-admin/auth');
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token, true);
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code === 'auth/id-token-expired') {
        throw ApiError.unauthorized('Session expired. Sign in again.');
      }
      if (code === 'auth/id-token-revoked') {
        throw ApiError.unauthorized('Session was revoked. Sign in again.');
      }
      logger().debug({ code }, 'firebase token verification failed');
      throw ApiError.unauthorized('Invalid authentication token');
    }
    return {
      driver: 'firebase',
      user: {
        uid: decoded.uid,
        email: decoded.email ?? null,
        displayName: (decoded.name as string | undefined) ?? null,
        emailVerified: Boolean(decoded.email_verified),
        // Role is resolved from trusted server state, never from the token claim.
        role: 'user',
        createdAt: decoded.auth_time
          ? new Date(decoded.auth_time * 1000).toISOString()
          : new Date().toISOString(),
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

export interface AuthInitResult {
  driver: AuthDriver;
  /** True when email/password sign-up and sign-in are served by this API. */
  localCredentials: boolean;
  note: string;
}

export async function initAuth(config: Config): Promise<AuthInitResult> {
  const requested = config.env.WOLF_FORGE_AUTH_DRIVER;
  const firebaseAvailable = config.firebase.configured;

  if (requested === 'firebase' && !firebaseAvailable) {
    throw new Error(
      'WOLF_FORGE_AUTH_DRIVER=firebase but Firebase Admin credentials are missing. ' +
        'See docs/configuration.md#firebase, or set WOLF_FORGE_AUTH_DRIVER=local for development.',
    );
  }

  if ((requested === 'firebase' || (requested === 'auto' && firebaseAvailable)) && firebaseAvailable) {
    // Ensure the Admin SDK app exists (initStore may not have run in tests).
    const { getApps, initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
    if (getApps().length === 0) {
      const credential =
        config.env.FIREBASE_PROJECT_ID &&
        config.env.FIREBASE_CLIENT_EMAIL &&
        config.env.FIREBASE_PRIVATE_KEY
          ? cert({
              projectId: config.env.FIREBASE_PROJECT_ID,
              clientEmail: config.env.FIREBASE_CLIENT_EMAIL,
              privateKey: config.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            })
          : applicationDefault();
      initializeApp({
        credential,
        ...(config.env.FIREBASE_PROJECT_ID ? { projectId: config.env.FIREBASE_PROJECT_ID } : {}),
      });
    }
    logger().info({ driver: 'firebase' }, 'authentication ready');
    return {
      driver: new FirebaseAuthDriver(),
      localCredentials: false,
      note: 'Firebase Authentication',
    };
  }

  if (config.isProduction && !config.env.WOLF_FORGE_ALLOW_LOCAL_AUTH_IN_PROD) {
    throw new Error(
      'Refusing to start: no Firebase credentials and NODE_ENV=production. The local auth ' +
        'driver is for development only. Configure Firebase, or set ' +
        'WOLF_FORGE_ALLOW_LOCAL_AUTH_IN_PROD=1 if you understand the risk.',
    );
  }

  const secret = config.env.WOLF_FORGE_LOCAL_AUTH_SECRET;
  if (secret.length < 32) {
    throw new Error(
      'WOLF_FORGE_LOCAL_AUTH_SECRET is missing or shorter than 32 characters. The local auth ' +
        'driver signs its own session tokens, so it needs a real secret. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  logger().warn(
    { driver: 'local' },
    'authentication ready — LOCAL DEVELOPMENT DRIVER, not for production',
  );
  return {
    driver: new LocalAuthDriver(secret),
    localCredentials: true,
    note: 'Local development auth (sessions signed by this server)',
  };
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}
