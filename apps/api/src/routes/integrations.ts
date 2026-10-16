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
import type { GitHubOAuthService } from '../integrations/github-oauth.js';
import { GitHubApi, pushFilesToGitHub } from '../integrations/github-api.js';
import type { OAuthStateService } from '../integrations/oauth-state.js';
import type { VercelDeploymentService } from '../integrations/vercel.js';
import { ApiError } from '../services/errors.js';
import type { AuditService } from '../audit/service.js';
import type { ArtifactStore } from '../services/artifacts.js';

const PushBodySchema = PushToGitHubRequestSchema.extend({
  projectId: z.string().min(1),
});

const PROVIDERS = ['github', 'vercel'] as const;
type Provider = (typeof PROVIDERS)[number];

const SkipBodySchema = z.object({
  returnTo: z.string().max(512).optional(),
});

/** Only same-app, relative return paths are accepted (never open redirects). */
function safeReturnTo(input: string | undefined): string {
  if (input && input.startsWith('/app/') && !input.includes('//') && !input.includes('\n') && !input.includes('\r')) {
    return input;
  }
  return '/app/connect';
}

export interface IntegrationDeps {
  config: Config;
  store: DocStore;
  github: GitHubIntegrationService;
  githubOAuth: GitHubOAuthService;
  oauthState: OAuthStateService;
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

  /** POST /api/v1/integrations/github/authorize — start the GitHub OAuth flow. */
  router.post('/github/authorize', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const body = z.object({ returnTo: z.string().max(512).optional() }).parse(req.body ?? {});
      const url = await deps.githubOAuth.buildAuthorizeUrl(p.user.uid, safeReturnTo(body.returnTo));
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'integrations.github.authorize',
        resourceType: 'integration',
        resourceId: `github_${p.user.uid}`,
        outcome: 'success',
      });
      res.json({ authorizeUrl: url, provider: 'github' });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/integrations/github/callback — provider redirect. Public by state. */
  router.get('/github/callback', async (req, res, next) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) throw ApiError.badRequest('GitHub OAuth callback missing the authorization code.');
      const { integration, returnTo, uid } = await deps.githubOAuth.handleCallback(state, code);
      await deps.audit.record({
        actorUid: uid,
        action: 'integrations.github.callback',
        resourceType: 'integration',
        resourceId: `github_${uid}`,
        outcome: 'success',
        metadata: { account: integration.accountLabel ?? undefined },
      });
      res.redirect(`${safeReturnTo(returnTo)}?connected=github`);
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/integrations/vercel/authorize — start the Vercel OAuth flow. */
  router.post('/vercel/authorize', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      if (!deps.vercel) throw ApiError.notConfigured('Vercel integration is not enabled.');
      const body = z.object({ returnTo: z.string().max(512).optional() }).parse(req.body ?? {});
      const state = await deps.oauthState.begin(p.user.uid, 'vercel', safeReturnTo(body.returnTo));
      const url = deps.vercel.buildAuthorizeUrl(p.user.uid, state);
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'integrations.vercel.authorize',
        resourceType: 'integration',
        resourceId: `vercel_${p.user.uid}`,
        outcome: 'success',
      });
      res.json({ authorizeUrl: url, provider: 'vercel' });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/integrations/vercel/callback — provider redirect. Public by state. */
  router.get('/vercel/callback', async (req, res, next) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) throw ApiError.badRequest('Vercel OAuth callback missing the authorization code.');
      if (!deps.vercel) throw ApiError.notConfigured('Vercel integration is not enabled.');
      if (!deps.vercel.oauthConfigured()) {
        throw ApiError.notConfigured('Vercel OAuth is not configured on the server.');
      }
      const record = await deps.oauthState.consume(state, 'vercel');
      if (!record) {
        throw ApiError.unauthorized(
          'Invalid or expired OAuth state. Close this tab and start the connection again.',
        );
      }
      const { token, username } = await deps.vercel.exchangeCodeForToken(code);
      await deps.vercel.storeOAuthToken(record.uid, token, { username });
      await deps.audit.record({
        actorUid: record.uid,
        action: 'integrations.vercel.callback',
        resourceType: 'integration',
        resourceId: `vercel_${record.uid}`,
        outcome: 'success',
        metadata: { account: username ?? undefined },
      });
      res.redirect(`${safeReturnTo(record.returnTo)}?connected=vercel`);
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/integrations/:provider/skip — persist "skip this for now". */
  router.post('/:provider/skip', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const provider = req.params.provider as Provider;
      if (provider !== 'github' && provider !== 'vercel') {
        throw ApiError.notFound(`Unknown integration provider "${req.params.provider}".`);
      }
      SkipBodySchema.parse(req.body ?? {});
      if (provider === 'github') {
        await deps.github.setSkipped(p.user.uid, true);
      } else if (provider === 'vercel') {
        await deps.vercel?.setSkipped(p.user.uid, true);
      }
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'integrations.skip',
        resourceType: 'integration',
        resourceId: `${provider}_${p.user.uid}`,
        outcome: 'success',
      });
      res.json({ provider, skipped: true });
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