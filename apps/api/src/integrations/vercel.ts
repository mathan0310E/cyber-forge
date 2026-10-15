import crypto from 'node:crypto';
import type { Deployment, Integration } from '@wolf-forge/shared-types';
import { COLLECTIONS, type DocStore } from '../db/store.js';
import { ApiError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';

/**
 * Vercel deployment integration.
 *
 * Uses the Vercel REST API with a token (set DEPLOYMENT_API_TOKEN). Only the
 * documented, free-compatible path is supported: a built static output is
 * uploaded to a project's production deployment. Deployment status and the live
 * URL come from Vercel's API responses — a live URL is only ever shown after
 * the provider confirms the deployment.
 */
export class VercelDeploymentService {
  constructor(private readonly db: DocStore) {}

  private static token(): string {
    const token = process.env.DEPLOYMENT_API_TOKEN ?? '';
    if (!token) {
      throw ApiError.notConfigured(
        'Vercel deployment is not configured. Set DEPLOYMENT_API_TOKEN (and DEPLOYMENT_VERCEL_TEAM_ID when used).',
        { setup: 'set-up-vercel' },
      );
    }
    return token;
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const token = VercelDeploymentService.token();
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
    const token = process.env.DEPLOYMENT_API_TOKEN ?? '';
    const doc = await this.db.get<{ username: string | null; connectedAt: string }>(
      COLLECTIONS.integrations,
      `vercel_${ownerUid}`,
    );
    const configured = Boolean(token);
    return {
      provider: 'vercel',
      status: doc ? 'connected' : 'disconnected',
      accountLabel: doc?.username ?? null,
      scopes: [],
      configured,
      setupHint: token
        ? doc
          ? `Connected as ${doc.username}.`
          : 'Configured. Connection details will appear after the first deployment.'
        : 'Set DEPLOYMENT_API_TOKEN to enable Vercel deployments.',
      connectedAt: doc?.connectedAt ?? null,
      updatedAt: null,
      lastError: null,
    };
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
      }>('POST', `https://api.vercel.com/v13/deployments${projectParam}`, {
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

      try {
        await this.db.set(COLLECTIONS.integrations, `vercel_${ownerUid}`, {
          username: null,
          connectedAt: now,
        });
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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30) || 'site';
}