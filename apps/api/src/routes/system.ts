import crypto from 'node:crypto';
import type { Router } from 'express';
import { Router as expressRouter } from 'express';
import type { DocStore } from '../db/store.js';
import type { Config } from '../config/env.js';
import type { AuditService } from '../audit/service.js';
import { ApiError } from '../services/errors.js';
import { getPreviewRegistry } from '../builds/preview-registry.js';

export interface SystemDeps {
  config: Config;
  store: DocStore;
  audit: AuditService;
  startedAt: number;
  sandboxInfo: { enabled: boolean; driver: string; isolationNote: string } | null;
  aiSummary: { providers: number; models: number; freeModels: number; catalogSource: string } | null;
}

/** GET /health — public liveness probe. */
export function createHealthRouter(deps: SystemDeps): Router {
  const router = expressRouter();
  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'wolf-forge-api',
      startedAt: deps.startedAt,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      sandbox: deps.sandboxInfo,
      ai: deps.aiSummary,
    });
  });
  return router;
}

/** GET /api/v1/system/status — authenticated runtime status. */
export function createStatusRouter(deps: SystemDeps): Router {
  const router = expressRouter();
  router.get('/status', (_req, res, next) => {
    try {
      res.json({
        ok: true,
        dataDriver: deps.store.driver,
        authDriver: deps.config.env.WOLF_FORGE_AUTH_DRIVER,
        sandbox: deps.sandboxInfo,
        ai: deps.aiSummary,
      });
    } catch (e) {
      next(e);
    }
  });
  return router;
}

/**
 * Preview proxy — mounted at `/preview/:id/*`.
 *
 * Fetches the preview container through its loopback port. The preview is
 * authorized by its 256-bit random access token alone (a fresh tab opened from
 * the workspace carries the token in the URL and has no API session). If the
 * request also carries an authenticated session, it must belong to the preview
 * owner as an extra check. Responses get a restrictive CSP and the preview runs
 * behind a `<base>` rewrite so generated code cannot read the app's own state.
 */
export function createPreviewRouter(): Router {
  const router = expressRouter();

  const proxy = async (req: import('express').Request, res: import('express').Response) => {
    const previewId = String(req.params.id ?? '');
    const token =
      typeof req.query.token === 'string'
        ? req.query.token
        : (req.headers['x-wolf-forge-preview-token'] as string | undefined);
    if (typeof token !== 'string' || token.length === 0) {
      throw ApiError.badRequest('Missing preview access token.');
    }

    const registry = getPreviewRegistry();
    // Token possession is the credential; the registry rejects wrong tokens
    // with a constant-time compare. The registered owner is used for scope.
    const preview = registry.get(previewId);
    if (!preview) throw ApiError.notFound('Preview is not running. Rebuild the project.');
    const expected = Buffer.from(preview.accessToken);
    const provided = Buffer.from(token);
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      throw ApiError.forbidden('Invalid preview access token');
    }
    // If a session is present, it must be the owner's.
    const principal = req.principal ?? null;
    if (principal && principal.user.uid !== preview.ownerUid) {
      throw ApiError.notFound('Preview not found');
    }
    registry.touch(previewId);

    // req.path still includes the mount prefix if the router was mounted at
    // "/preview"; strip `/preview/:id` whichever way it appears.
    const outboundPath = req.path.replace(/^\/preview\/[^/]+/, '').replace(/^\/[^/]+/, '');
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const normalized = outboundPath.startsWith('/') || outboundPath === '' ? outboundPath : `/${outboundPath}`;
    const target = `http://127.0.0.1:${preview.port}${normalized}${query}`;
    const upstream = await fetch(target, {
      method: req.method,
      headers: mapHeaders(req),
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const contentType = String(upstream.headers.get('content-type') ?? '');
    const baseHref = `/preview/${preview.id}/`;

    if (contentType.includes('text/html')) {
      let html = buf.toString('utf8');
      html = html.replace(/(href|src)=(["'])\/(?!\/)/g, `$1=$2${baseHref}`);
      html = html.replace(/<base\b[^>]*>/i, '');
      html = html.replace('</head>', `<base href="${baseHref}"></head>`);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; script-src 'self' 'unsafe-inline';",
      );
      res.send(html);
      return;
    }

    for (const [key, value] of upstream.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        ['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(
          lower,
        )
      ) {
        continue;
      }
      res.setHeader(key, value);
    }
    res.setHeader('x-wolf-forge-preview', preview.id);
    res.send(buf);
  };

  router.get('/:id', (req, res, next) => proxy(req, res).catch(next));
  router.get('/:id/*', (req, res, next) => proxy(req, res).catch(next));

  return router;
}

function mapHeaders(req: import('express').Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith('host') ||
      lower.startsWith('connection') ||
      lower === 'authorization' ||
      lower.startsWith('x-wolf-forge')
    ) {
      continue;
    }
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.join(', ');
  }
  return out;
}