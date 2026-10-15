import type { Router } from 'express';
import { Router as expressRouter } from 'express';
import { z } from 'zod';
import {
  CreateRepositoryRequestSchema,
  GitHubConnectRequestSchema,
  PushToGitHubRequestSchema,
} from '@wolf-forge/shared-types';
import type { Config } from '../config/env.js';
import type { DocStore } from '../db/store.js';
import type { GitHubIntegrationService } from '../integrations/github.js';
import { GitHubApi, pushFilesToGitHub } from '../integrations/github-api.js';
import type { VercelDeploymentService } from '../integrations/vercel.js';
import { ApiError } from '../services/errors.js';
import type { AuditService } from '../audit/service.js';
import type { ArtifactStore } from '../services/artifacts.js';

const PushBodySchema = PushToGitHubRequestSchema.extend({
  projectId: z.string().min(1),
});

export interface IntegrationDeps {
  config: Config;
  store: DocStore;
  github: GitHubIntegrationService;
  vercel?: VercelDeploymentService;
  artifacts: ArtifactStore;
  audit: AuditService;
  getProjectFiles(projectId: string): Promise<Array<{ path: string; content: string }>>;
}

export function createIntegrationsRouter(deps: IntegrationDeps): Router {
  const router = expressRouter();

  /** GET /api/v1/integrations */
  router.get('/', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const github = await deps.github.statusFor(p.user.uid);
      const vercel = deps.vercel ? await deps.vercel.statusFor(p.user.uid) : null;
      const integrations = [github, ...(vercel ? [vercel] : [])];
      res.json({ integrations });
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/integrations/github/connect — PAT path. */
  router.post('/github/connect', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const body = GitHubConnectRequestSchema.parse(req.body ?? {});
      if (!body.token) {
        throw ApiError.badRequest('Provide a GitHub personal access token (repo scope).');
      }
      // Verify the token before storing it: we never claim a connection that
      // does not actually authenticate.
      const api = new GitHubApi(body.token);
      const user = await api.getUser();
      const integration = await deps.github.storeToken(p.user.uid, body.token, {
        account: user.login,
        scopes: ['repo'],
      });
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'integrations.github.connect',
        resourceType: 'integration',
        resourceId: `github_${p.user.uid}`,
        outcome: 'success',
        metadata: { account: user.login },
      });
      res.json({ integration, repositoryPath: user.login });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/integrations/github/repositories */
  router.get('/github/repositories', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const token = await deps.github.getToken(p.user.uid);
      const api = new GitHubApi(token);
      const repositories = await api.listRepositories();
      res.json({ repositories });
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/integrations/github/repositories — create a new repo. */
  router.post('/github/repositories', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const input = CreateRepositoryRequestSchema.parse(req.body ?? {});
      const token = await deps.github.getToken(p.user.uid);
      const api = new GitHubApi(token);
      const repo = await api.createRepository(input);
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'integrations.github.createRepository',
        resourceType: 'integration',
        resourceId: `github_${p.user.uid}`,
        outcome: 'success',
        metadata: { fullName: repo.fullName, private: repo.private },
      });
      res.status(201).json({ repository: repo });
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/integrations/github/push — push current project version. */
  router.post('/github/push', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const input = PushBodySchema.parse(req.body ?? {});
      const token = await deps.github.getToken(p.user.uid);
      const files = await deps.getProjectFiles(input.projectId);

      let repository = input.repository;
      if (input.createIfMissing) {
        const api = new GitHubApi(token);
        const exists = await api.repositoryExists(repository);
        if (!exists) {
          const [owner] = repository.split('/') as [string, string];
          const name = repository.split('/')[1]!;
          const created = await api.createRepository({
            name,
            description: 'Generated with Wolf Forge',
            private: input.private,
          });
          repository = created.fullName;
          void owner;
        }
      }

      const result = await pushFilesToGitHub({
        token,
        repository,
        branch: input.branch,
        commitMessage: input.commitMessage,
        files,
      });
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'integrations.github.push',
        resourceType: 'repository',
        resourceId: repository,
        outcome: 'success',
        metadata: { branch: result.branch, filesPushed: result.filesPushed },
      });
      res.json({ result });
    } catch (e) {
      next(e);
    }
  });

  /** DELETE /api/v1/integrations/:provider */
  router.delete('/:provider', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const provider = req.params.provider;
      if (provider !== 'github' && provider !== 'vercel') {
        throw ApiError.notFound(`Unknown integration provider "${provider}".`);
      }
      if (provider === 'github') {
        await deps.github.disconnect(p.user.uid);
      } else if (provider === 'vercel') {
        await deps.store.delete('integrations', `vercel_${p.user.uid}`);
      }
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'integrations.disconnect',
        resourceType: 'integration',
        resourceId: `${provider}_${p.user.uid}`,
        outcome: 'success',
      });
      res.json({ ok: true, provider });
    } catch (e) {
      next(e);
    }
  });

  return router;
}