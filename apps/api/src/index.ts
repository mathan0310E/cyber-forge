import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import type { Config } from './config/env.js';
import { loadConfig } from './config/env.js';
import { initStore } from './db/index.js';
import { initAuth } from './services/auth-driver.js';
import { initLogger, logger } from './services/logger.js';
import { initSandbox } from './sandbox/index.js';
import { initAiServices } from './ai/config-service.js';
import { GenerationPipeline } from './builds/pipeline.js';
import { BuildRunner } from './builds/runner.js';
import { BuildJobRepository, BuildEventRepository } from './builds/job-store.js';
import { UserRepository } from './services/users.js';
import { ProjectRepository, VersionRepository } from './projects/repository.js';
import { ArtifactStore } from './services/artifacts.js';
import { UsageService } from './usage/service.js';
import { AuditService } from './audit/service.js';
import { GitHubIntegrationService } from './integrations/github.js';
import { GitHubOAuthService } from './integrations/github-oauth.js';
import { OAuthStateService } from './integrations/oauth-state.js';
import { VercelDeploymentService } from './integrations/vercel.js';
import { DeploymentService } from './deployments/service.js';
import { initPreviewRegistry } from './builds/preview-registry.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimiters } from './middleware/rate-limit.js';
import { requestContext } from './middleware/request-context.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createAuthRouter } from './routes/auth.js';
import { createProjectsRouter } from './routes/projects.js';
import { createBuildsRouter, createProjectBuildsAliasRouter } from './routes/builds.js';
import { createAiRouter } from './routes/ai.js';
import { createIntegrationsRouter } from './routes/integrations.js';
import { createDeploymentsRouter } from './routes/deployments.js';
import {
  createHealthRouter,
  createStatusRouter,
  createPreviewRouter,
  type SystemDeps,
} from './routes/system.js';

const startedAt = Date.now();

async function bootstrap(): Promise<{ app: express.Express; config: Config }> {
  // Load .env early so every downstream module sees the same process env.
  await import('dotenv/config');
  const config = loadConfig();
  initLogger(config);

  // Persistence + auth + sandbox: each throws a helpful startup error when its
  // required configuration is absent rather than pretending to work.
  const { store } = await initStore(config);
  const { driver } = await initAuth(config);
  const sandbox = await initSandbox(config);

  // Repositories and services.
  const users = new UserRepository(store);
  const projects = new ProjectRepository(store);
  const versions = new VersionRepository(store);
  const artifacts = new ArtifactStore(config.env.ARTIFACT_STORAGE_PATH);
  await artifacts.init();
  const jobs = new BuildJobRepository(store);
  const events = new BuildEventRepository(store);
  const usage = new UsageService(store, config);
  const audit = new AuditService(store);
  const previews = initPreviewRegistry(config);

  // AI services (registers provider adapters + router; may be unconfigured).
  const ai = await initAiServices(config, store);

  // Pipeline + runner.
  const pipeline = new GenerationPipeline({
    config,
    jobs,
    events,
    projects,
    versions,
    artifacts,
    store,
    router: ai.router,
    previews,
  });
  const runner = new BuildRunner(pipeline, usage);

  // GitHub integration (token encryption at rest).
  const github = new GitHubIntegrationService(store, {
    clientId: config.env.GITHUB_CLIENT_ID,
    clientSecret: config.env.GITHUB_CLIENT_SECRET,
    callbackUrl: config.env.GITHUB_OAUTH_CALLBACK_URL,
    encryptionKey: config.env.INTEGRATION_ENCRYPTION_KEY,
  });
  const oauthState = new OAuthStateService(store);
  const githubOAuth = new GitHubOAuthService(github, oauthState, {
    clientId: config.env.GITHUB_CLIENT_ID,
    clientSecret: config.env.GITHUB_CLIENT_SECRET,
    callbackUrl: config.env.GITHUB_OAUTH_CALLBACK_URL,
  });
  const vercel = new VercelDeploymentService(store, {
    clientId: config.env.VERCEL_CLIENT_ID,
    clientSecret: config.env.VERCEL_CLIENT_SECRET,
    callbackUrl: config.env.VERCEL_OAUTH_CALLBACK_URL,
    encryptionKey: config.env.INTEGRATION_ENCRYPTION_KEY,
  });
  const deployments = new DeploymentService(store, vercel);

  const systemDeps: SystemDeps = {
    config,
    store,
    audit,
    startedAt,
    sandboxInfo: {
      enabled: true,
      driver: sandbox.driver.id,
      isolationNote: sandbox.driver.isolationNote,
    },
    aiSummary: ai
      ? {
          providers: ai.providers.size,
          models: ai.registry.all().length,
          freeModels: ai.registry.all().filter((m) => m.eligibility === 'verified-free').length,
          catalogSource: ai.registry.lastFetch.source,
        }
      : null,
  };
  const adminUids = new Set(
    config.env.WOLF_FORGE_ADMIN_UIDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const requireAuth = createAuthMiddleware({ driver, users, config, adminUids });
  const rateLimiters = createRateLimiters(
    config.quotas.requestsPerMinute,
    config.isTest,
  );

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestContext);
  app.use(helmet());
  app.use(
    cors({
      origin: config.webOrigins,
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  // ----- Auth (public) ------------------------------------------------------
  app.use(
    '/api/v1/auth',
    rateLimiters.credentials,
    createAuthRouter({ config, driver, users, store, audit, requireAuth }),
  );
  app.get('/api/v1/me', requireAuth, (req, res) => {
    res.json({ user: req.principal!.user, driver: driver.id });
  });

  // ----- Health probe (public) ----------------------------------------------
  app.use(createHealthRouter(systemDeps));

  // ----- Global auth gate ---------------------------------------------------
  // Everything except the whitelist below requires a session. Previews are
  // exempt because they are authenticated by their 256-bit random access token
  // (validated against the running registry by the proxy route itself).
  app.use((req, _res, next) => {
    const path = req.path;
    if (path === '/health') return next();
    if (path.startsWith('/api/v1/auth')) return next();
    // Provider OAuth callbacks are public: they are authenticated by the
    // one-time `state` binding verified inside the callback handler, not by a
    // browser session (the authorization window runs outside our origin).
    if (path.startsWith('/api/v1/integrations/github/callback')) return next();
    if (path.startsWith('/api/v1/integrations/vercel/callback')) return next();
    if (path.startsWith('/preview/')) return next();
    return requireAuth(req, _res, next);
  });
  app.use(rateLimiters.general);

  // Per-request "who am I" for closures that build URLs relative to a user.
  const reqScope = { uid: '' };
  app.use('/api/v1', (req, _res, next) => {
    if (req.principal?.user.uid) reqScope.uid = req.principal.user.uid;
    next();
  });

  const getProjectFiles = async (projectId: string) => {
    const project = await projects.getOwned(projectId, reqScope.uid);
    if (!project.currentVersionId) return [];
    return artifacts.readAllFiles(project.id, project.currentVersionId);
  };

  app.use('/api/v1/projects', createProjectBuildsAliasRouter({ config, projects, jobs, runner, usage, events }));
  app.use('/api/v1/projects', createProjectsRouter({
    config,
    store,
    projects,
    versions,
    artifacts,
    jobs,
    events,
    runner,
    usage,
    audit,
    previewsStop: (projectId) => previews.stopForProject(projectId),
  }));

  app.use(
    '/api/v1/builds',
    createBuildsRouter({ config, projects, jobs, events, runner, usage }),
  );

  app.use(
    '/api/v1/ai',
    createAiRouter({
      config,
      store,
      services: ai,
      usage,
      audit,
      projectsCount: () => projects.countForUser(reqScope.uid),
    }),
  );

  app.use(
    '/api/v1/integrations',
    createIntegrationsRouter({
      config,
      store,
      github,
      githubOAuth,
      oauthState,
      vercel,
      artifacts,
      audit,
      getProjectFiles,
    }),
  );

  app.use(
    '/api/v1/deployments',
    createDeploymentsRouter({
      config,
      store,
      projects,
      versions,
      artifacts,
      deployments,
      audit,
    }),
  );

  // Status (authenticated) + preview proxy (token-authenticated).
  app.use('/api/v1/system', createStatusRouter(systemDeps));
  app.use('/preview', createPreviewRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, config };
}

let server: http.Server | undefined;

async function main(): Promise<void> {
  const { app, config } = await bootstrap();
  const port = config.env.PORT;
  server = app.listen(port, '0.0.0.0', () => {
    const log = logger();
    log.info({ port, webOrigin: config.webOrigins[0] }, 'Wolf Forge API listening');
  });
}

async function shutdown(_signal: string): Promise<void> {
  const log = logger();
  log.info({ signal: _signal }, 'shutting down');
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => void shutdown(sig));
}

// Only listen when executed directly (tests import bootstrap instead).
if (process.argv[1] && /index\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    logger().fatal({ err: String(e) }, 'fatal startup error');
    process.exit(1);
  });
}

export { bootstrap };