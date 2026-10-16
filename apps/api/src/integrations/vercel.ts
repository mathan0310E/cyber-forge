import crypto from 'node:crypto';
import type { Deployment, Integration } from '@wolf-forge/shared-types';
import { COLLECTIONS, type DocStore } from '../db/store.js';
import { ApiError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';

/**
 * Vercel deployment integration.
 *
 * Two token paths:
 *  1. Per-user OAuth App flow — the user connects their own Vercel account.
 *     The token is encrypted at rest with INTEGRATION_ENCRYPTION_KEY.
 *  2. A shared DEPLOYMENT_API_TOKEN (server operator's account), used as a
 *     fallback when the user has not connected their own account.
 *
 * Only the documented, free-compatible path is supported: a built static
 * output is uploaded to a project's production deployment. Deployment status
 * and the live URL come from Vercel's API responses — a live URL is only ever
 * shown after the provider confirms the deployment.
 */
export class VercelDeploymentService {
  constructor(
    private readonly db: DocStore,
    private readonly config: {
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
      encryptionKey: string;
    },
  ) {}

  private docId(ownerUid: string): string {
    return `vercel_${ownerUid}`;
  }

  private key32(): Buffer {
    if (this.config.encryptionKey.length < 32) {
      throw ApiError.notConfigured(
        'Vercel tokens are encrypted at rest, which needs INTEGRATION_ENCRYPTION_KEY ' +
          '(at least 32 characters). Generate one with: node -e ' +
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
        'The stored Vercel token could not be decrypted. The encryption key may have changed; reconnect the integration.',
      );
    }
  }

  oauthConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  buildAuthorizeUrl(uid: string, state: string): string {
    void uid;
    if (!this.oauthConfigured()) {
      throw ApiError.notConfigured(
        'Vercel OAuth is not configured. Set VERCEL_CLIENT_ID and VERCEL_CLIENT_SECRET, or deploy with the server account token.',
        { setup: 'set-up-vercel-oauth' },
      );
    }
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      response_type: 'code',
      scope: '',
      state,
    });
    return `https://vercel.com/oauth/authorize?${params.toString()}`;
  }

  /**
   * Resolves the token to use for this user: their own OAuth token first, then
   * the server-level DEPLOYMENT_API_TOKEN as a fallback.
   */
  private async tokenFor(ownerUid: string): Promise<string> {
    const doc = await this.db.get<{ token: { ciphertext: string; iv: string } }>(
      COLLECTIONS.integrations,
      this.docId(ownerUid),
    );
    if (doc?.token) {
      return this.decrypt(doc.token);
    }
    const token = process.env.DEPLOYMENT_API_TOKEN ?? '';
    if (!token) {
      throw ApiError.notConfigured(
        'Vercel deployment is not configured. Connect your Vercel account, or ask the operator to set DEPLOYMENT_API_TOKEN.',
        { setup: 'connect-vercel' },
      );
    }
    return token;
  }

  private async request<T>(
    ownerUid: string,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const token = await this.tokenFor(ownerUid);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'WolfForge/0.1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text().catch(() => '');
    let data: T | Record<string, unknown> | string = {} as T;
    if (raw) {
      try {
        data = JSON.parse(raw) as T;
      } catch {
        data = raw.slice(0, 500);
      }
    }
    if (!res.ok) {
      const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
      const error =
        record &&
        (typeof record.error === 'object' || typeof record.error === 'string' || typeof record.error === 'undefined')
          ? (record.error as Record<string, unknown> | string | undefined)
          : undefined;
      const message =
        (typeof error === 'object' && error !== null
          ? (error.message as string | undefined)
          : typeof error === 'string'
            ? error
            : undefined) ??
        (record?.message as string | undefined) ??
        'Vercel API error';
      throw ApiError.deploymentFailed(`Vercel returned ${res.status}: ${String(message).slice(0, 300)}`);
    }
    return { status: res.status, data: data as T };
  }

  async statusFor(ownerUid: string): Promise<Integration> {
    const globalToken = process.env.DEPLOYMENT_API_TOKEN ?? '';
    const doc = await this.db.get<{
      token?: { ciphertext: string; iv: string } | null;
      username: string | null;
      connectedAt: string;
      skipped: boolean;
    }>(COLLECTIONS.integrations, this.docId(ownerUid));
    const hasUserToken = Boolean(doc?.token);
    const connected = hasUserToken || Boolean(doc?.username);
    const oauthAvailable = this.oauthConfigured() && this.config.encryptionKey.length >= 32;

    const accountLabel = connected
      ? (doc?.username ?? (hasUserToken ? 'Vercel account' : null))
      : null;
    const status: Integration['status'] = connected ? 'connected' : 'disconnected';

    let setupHint: string;
    if (connected) {
      setupHint = `Connected as ${accountLabel ?? 'Vercel account'}.`;
    } else if (globalToken) {
      setupHint = 'Configured with the server account. Deployments will use its quota.';
    } else if (oauthAvailable) {
      setupHint = 'Connect your Vercel account to deploy (OAuth).';
    } else {
      setupHint = 'Set VERCEL_CLIENT_ID/SECRET to enable OAuth, or DEPLOYMENT_API_TOKEN for the server account.';
    }

    return {
      provider: 'vercel',
      status,
      accountLabel,
      scopes: [],
      configured: Boolean(globalToken) || hasUserToken,
      setupHint,
      connectedAt: doc?.connectedAt ?? null,
      updatedAt: null,
      lastError: null,
      skipped: Boolean(doc?.skipped),
      oauthAvailable,
    };
  }

  /** Persists the user's explicit "skip this for now" choice. */
  async setSkipped(ownerUid: string, skipped: boolean): Promise<void> {
    const id = this.docId(ownerUid);
    const existing = await this.db.get<Record<string, unknown>>(COLLECTIONS.integrations, id);
    await this.db.set<object>(COLLECTIONS.integrations, id, {
      ...(existing ?? {}),
      skipped,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Persists an OAuth token (encrypted at rest). */
  async storeOAuthToken(
    ownerUid: string,
    token: string,
    account: { username: string | null },
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.set(COLLECTIONS.integrations, this.docId(ownerUid), {
      token: this.encrypt(token),
      username: account.username,
      connectedAt: now,
      updatedAt: now,
      lastError: null,
      skipped: false,
    });
  }

  /** Exchanges a Vercel OAuth code for a token, resolving account identity. */
  async exchangeCodeForToken(code: string): Promise<{ token: string; username: string | null }> {
    const res = await fetch('https://api.vercel.com/v1/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.callbackUrl,
      }),
    });
    if (!res.ok) {
      throw ApiError.integrationError(`Vercel OAuth token endpoint returned HTTP ${res.status}.`);
    }
    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    } | null;
    if (!body?.access_token) {
      throw ApiError.integrationError(
        `Vercel OAuth failed: ${body?.error_description ?? body?.error ?? 'no access token returned'}`,
      );
    }
    const token = body.access_token;
    let username: string | null = null;
    try {
      const userRes = await fetch('https://api.vercel.com/www/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'WolfForge/0.1',
        },
      });
      if (userRes.ok) {
        const userData = (await userRes.json().catch(() => null)) as {
          user?: { username?: string } | null;
        } | null;
        username = userData?.user?.username ?? null;
      }
    } catch {
      /* identity lookup is best-effort; not fatal */
    }
    return { token, username };
  }

  /**
   * Creates a deployment from a built `dist/` directory. `files` are the exact
   * static assets that a previous successful build produced — nothing is
   * fabricated: Vercel's response decides success and the URL.
   */
  async deployBuiltSite(
    ownerUid: string,
    projectId: string,
    files: Array<{ path: string; content: string }>,
    projectName: string,
    versionId: string | null,
  ): Promise<Deployment> {
    const log = childLogger({ component: 'vercel', projectId });
    const deploymentId = `dep_${crypto.randomBytes(10).toString('hex')}`;
    const now = new Date().toISOString();

    const teamParam = process.env.DEPLOYMENT_VERCEL_TEAM_ID
      ? `?teamId=${encodeURIComponent(process.env.DEPLOYMENT_VERCEL_TEAM_ID)}`
      : '';
    const projectParam = process.env.DEPLOYMENT_VERCEL_PROJECT_ID
      ? `?projectId=${encodeURIComponent(process.env.DEPLOYMENT_VERCEL_PROJECT_ID)}`
      : teamParam;

    try {
      await this.db.set(COLLECTIONS.deployments, deploymentId, {
        id: deploymentId,
        projectId,
        ownerUid,
        provider: 'vercel',
        status: 'queued',
        versionId,
        providerDeploymentId: null,
        liveUrl: null,
        errorSummary: null,
        createdAt: now,
        updatedAt: now,
      } as unknown as Deployment);

      const { data: deploy } = await this.request<{
        url: string;
        id: string;
        readyState: string;
        alias: string[];
      }>(ownerUid, 'POST', `https://api.vercel.com/v13/deployments${projectParam}`, {
        name: sanitizeVercelName(projectName),
        files: files.slice(0, 300).map((f) => ({
          file: f.path,
          data: Buffer.from(f.content).toJSON().data, // raw bytes
        })),
        projectSettings: { framework: 'vite' },
        target: 'production',
      });

      const liveUrl = deploy.url
        ? `https://${deploy.url}`
        : deploy.alias?.[0]
          ? `https://${deploy.alias[0]}`
          : null;

      if (!liveUrl) {
        throw ApiError.deploymentFailed(
          'Vercel created the deployment but returned no URL. Check the account limits.',
        );
      }

      await this.db.update<Deployment>(COLLECTIONS.deployments, deploymentId, {
        status: 'ready',
        versionId,
        providerDeploymentId: deploy.id,
        liveUrl,
        updatedAt: new Date().toISOString(),
      });

      // Remember the connection marker for users who went through OAuth; for
      // server-token deploys this is the first proof the deployment worked.
      try {
        const current = await this.db.get<{ token?: unknown; username?: string | null }>(
          COLLECTIONS.integrations,
          this.docId(ownerUid),
        );
        if (!current?.token) {
          await this.db.update<object>(COLLECTIONS.integrations, this.docId(ownerUid), {
            username: null,
            connectedAt: now,
            skipped: false,
            updatedAt: now,
          });
        }
      } catch {
        /* non-fatal */
      }

      log.info({ deploymentId, url: liveUrl }, 'vercel deployment confirmed');
      return (await this.db.get<Deployment>(COLLECTIONS.deployments, deploymentId))!;
    } catch (e) {
      await this.db.update<Deployment>(COLLECTIONS.deployments, deploymentId, {
        status: 'error',
        errorSummary: e instanceof Error ? e.message.slice(0, 1000) : String(e),
        updatedAt: new Date().toISOString(),
      });
      throw e;
    }
  }
}

function sanitizeVercelName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 30) || 'site'
  );
}
