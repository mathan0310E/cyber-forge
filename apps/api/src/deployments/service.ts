import type { Deployment } from '@wolf-forge/shared-types';
import { COLLECTIONS, type DocStore, type WhereClause } from '../db/store.js';
import { ApiError } from '../services/errors.js';
import { VercelDeploymentService } from '../integrations/vercel.js';

/**
 * Provider-neutral deployment service.
 *
 * Currently the only implemented provider is Vercel. When no provider is
 * configured the API reports an honest `not_configured` state and the UI shows
 * a setup-required message — a live URL is never fabricated.
 */
export class DeploymentService {
  private readonly vercel: VercelDeploymentService;

  constructor(private readonly store: DocStore) {
    this.vercel = new VercelDeploymentService(store);
  }

  async createForProject(input: {
    ownerUid: string;
    projectId: string;
    versionId?: string;
    files: Array<{ path: string; content: string }>;
    projectName: string;
  }): Promise<Deployment> {
    const resolved = input.versionId ?? null;
    const deployment = await this.vercel.deployBuiltSite(
      input.ownerUid,
      input.projectId,
      input.files,
      input.projectName,
      resolved,
    );
    return deployment;
  }

  async getOwned(deploymentId: string, ownerUid: string): Promise<Deployment> {
    const dep = await this.store.get<Deployment>(COLLECTIONS.deployments, deploymentId);
    if (!dep || dep.ownerUid !== ownerUid) throw ApiError.notFound('Deployment not found');
    return dep;
  }

  /** Deployment history for a project, newest first. */
  async listForProject(projectId: string, ownerUid: string, limit = 20) {
    const where: WhereClause[] = [
      { field: 'projectId', op: '==', value: projectId },
      { field: 'ownerUid', op: '==', value: ownerUid },
    ];
    return this.store.query<Deployment>(COLLECTIONS.deployments, {
      where,
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
      limit,
    });
  }

  async integrationStatus(ownerUid: string) {
    const status = await this.vercel.statusFor(ownerUid).catch(() => ({
      provider: 'vercel' as const,
      status: 'disconnected' as const,
      accountLabel: null,
      scopes: [],
      configured: false,
      setupHint: 'Vercel is not configured in this environment.',
      connectedAt: null,
      updatedAt: null,
      lastError: null,
    }));
    return status;
  }
}