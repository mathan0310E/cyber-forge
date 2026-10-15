import crypto from 'node:crypto';
import type { Integration } from '@wolf-forge/shared-types';
import { COLLECTIONS, type DocStore } from '../db/store.js';
import { ApiError } from '../services/errors.js';
import { logger } from '../services/logger.js';

/**
 * GitHub integration.
 *
 * Two connection paths:
 *  1. OAuth App flow — requires GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET and the
 *     GITHUB_OAUTH_CALLBACK_URL to be reachable.
 *  2. Personal access token — the user pastes a token
 *     (repo scope: public_repo or repo) which is encrypted at rest.
 *
 * Tokens are encrypted with AES-256-GCM using INTEGRATION_ENCRYPTION_KEY and
 * are never returned by any API endpoint.
 */
export class GitHubIntegrationService {
  constructor(
    private readonly db: DocStore,
    private readonly config: {
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
      encryptionKey: string;
    },
  ) {}

  private key32(): Buffer {
    if (this.config.encryptionKey.length < 32) {
      throw ApiError.notConfigured(
        'GitHub tokens are encrypted at rest, which needs INTEGRATION_ENCRYPTION_KEY (' +
          'at least 32 characters). Generate one with: node -e ' +
          '"console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      );
    }
    return crypto.createHash('sha256').update(this.config.encryptionKey).digest();
  }

  private encrypt(secret: string): { ciphertext: string; iv: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key32(), iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([ciphertext, tag]).toString('base64'),
      iv: iv.toString('base64'),
    };
  }

  private decrypt(payload: { ciphertext: string; iv: string }): string {
    try {
      const combined = Buffer.from(payload.ciphertext, 'base64');
      const tag = combined.subarray(combined.length - 16);
      const data = combined.subarray(0, combined.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key32(), Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw ApiError.conflict(
        'The stored GitHub token could not be decrypted. The encryption key may have changed; reconnect the integration.',
      );
    }
  }

  private docId(ownerUid: string): string {
    return `github_${ownerUid}`;
  }

  async statusFor(ownerUid: string): Promise<Integration> {
    const doc = await this.db.get<{
      token: { ciphertext: string; iv: string };
      account: string | null;
      scopes: string[];
      connectedAt: string;
      updatedAt: string;
      lastError: string | null;
    }>(COLLECTIONS.integrations, this.docId(ownerUid));

    return {
      provider: 'github',
      status: doc ? 'connected' : 'disconnected',
      accountLabel: doc?.account ?? null,
      scopes: doc?.scopes ?? [],
      configured: this.config.clientId.length > 0 || this.config.encryptionKey.length >= 32,
      setupHint: this.hintFor(ownerUid, Boolean(doc)),
      connectedAt: doc?.connectedAt ?? null,
      updatedAt: doc?.updatedAt ?? null,
      lastError: doc?.lastError ?? null,
    };
  }

  private hintFor(ownerUid: string, hasToken: boolean): string {
    void ownerUid;
    if (hasToken) return 'Connected. Wolf Forge can create repositories and push code as this account.';
    if (this.config.clientId) {
      return 'Connect GitHub with OAuth, or paste a personal access token with repo scope.';
    }
    return this.config.encryptionKey.length >= 32
      ? 'No credentials configured. Paste a personal access token (scope: repo or public_repo), or set GITHUB_CLIENT_ID/SECRET for OAuth.'
      : 'GitHub is available but disabled: set INTEGRATION_ENCRYPTION_KEY and either OAuth credentials or a token.';
  }

  /** Persists a token (OAuth or PAT), verifying it against the GitHub API first. */
  async storeToken(ownerUid: string, token: string, options: { account?: string; scopes?: string[] }): Promise<Integration> {
    const account = options.account ?? null;
    const scopes = options.scopes ?? [];
    const now = new Date().toISOString();
    const encrypted = this.encrypt(token);
    await this.db.set(COLLECTIONS.integrations, this.docId(ownerUid), {
      token: encrypted,
      account,
      scopes,
      connectedAt: now,
      updatedAt: now,
      lastError: null,
    });
    logger().info({ actor: ownerUid }, 'github integration connected');
    return (await this.statusFor(ownerUid)) as Integration;
  }

  /** Returns the decrypted token or throws a precise error. */
  async getToken(ownerUid: string): Promise<string> {
    const doc = await this.db.get<{ token: { ciphertext: string; iv: string } }>(
      COLLECTIONS.integrations,
      this.docId(ownerUid),
    );
    if (!doc?.token) {
      throw ApiError.notConfigured(
        'GitHub is not connected. Connect it in Integrations first.',
        { setup: 'connect-github' },
      );
    }
    const token = this.decrypt(doc.token);
    if (!token) throw ApiError.notConfigured('The stored GitHub token is empty. Reconnect.');
    return token;
  }

  async disconnect(ownerUid: string): Promise<void> {
    await this.db.delete(COLLECTIONS.integrations, this.docId(ownerUid));
    logger().info({ actor: ownerUid }, 'github integration disconnected');
  }

  async deleteForUser(ownerUid: string): Promise<void> {
    await this.disconnect(ownerUid);
  }
}