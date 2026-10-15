import type { Router } from 'express';
import { Router as expressRouter } from 'express';
import { CreateDeploymentRequestSchema } from '@wolf-forge/shared-types';
import type { Config } from '../config/env.js';
import type { DocStore } from '../db/store.js';
import type { ProjectRepository, VersionRepository } from '../projects/repository.js';
import type { ArtifactStore } from '../services/artifacts.js';
import type { DeploymentService } from '../deployments/service.js';
import { ApiError } from '../services/errors.js';
import type { AuditService } from '../audit/service.js';

export interface DeploymentDeps {
  config: Config;
  store: DocStore;
  projects: ProjectRepository;
  versions: VersionRepository;
  artifacts: ArtifactStore;
  deployments: DeploymentService;
  audit: AuditService;
}

export function createDeploymentsRouter(deps: DeploymentDeps): Router {
  const router = expressRouter();

  /** POST /api/v1/projects/:projectId/deployments */
  router.post('/projects/:projectId/deployments', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const input = CreateDeploymentRequestSchema.parse(req.body ?? {});

      const project = await deps.projects.getOwned(req.params.projectId, p.user.uid);
      const status = await deps.deployments.integrationStatus(p.user.uid);
      if (!status.configured) {
        throw ApiError.notConfigured(status.setupHint ?? 'Deployment provider is not configured.');
      }

      const versionId = input.versionId ?? project.currentVersionId ?? null;
      if (!versionId) {
        throw ApiError.conflict('This project has no build yet. Run a build before deploying.');
      }
      const files = await deps.artifacts.readAllFiles(project.id, versionId);

      const deployment = await deps.deployments.createForProject({
        ownerUid: p.user.uid,
        projectId: project.id,
        versionId: versionId as string,
        files,
        projectName: project.name,
      });
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'deployments.create',
        resourceType: 'deployment',
        resourceId: deployment.id,
        outcome: 'success',
        metadata: { provider: deployment.provider, versionId: deployment.versionId },
      });
      res.status(202).json({ deployment });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/deployments/:deploymentId */
  router.get('/:deploymentId', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const deployment = await deps.deployments.getOwned(req.params.deploymentId, p.user.uid);
      res.json(deployment);
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/projects/:projectId/deployments */
  router.get('/projects/:projectId/deployments', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      await deps.projects.getOwned(req.params.projectId, p.user.uid);
      const items = await deps.deployments.listForProject(req.params.projectId, p.user.uid, 20);
      res.json({ items });
    } catch (e) {
      next(e);
    }
  });

  return router;
}