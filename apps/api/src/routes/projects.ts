import crypto from 'node:crypto';
import type { Router } from 'express';
import { Router as expressRouter } from 'express';
import {
  CreateProjectRequestSchema,
  ListProjectsQuerySchema,
  UpdateProjectRequestSchema,
} from '@wolf-forge/shared-types';
import type { Config } from '../config/env.js';
import { COLLECTIONS, type DocStore } from '../db/store.js';
import { ApiError } from '../services/errors.js';
import type { ArtifactStore } from '../services/artifacts.js';
import type { ProjectRepository, VersionRepository } from '../projects/repository.js';
import type { BuildJobRepository, BuildEventRepository } from '../builds/job-store.js';
import type { BuildRunner } from '../builds/runner.js';
import type { UsageService } from '../usage/service.js';
import type { AuditService } from '../audit/service.js';
import { buildZipArchive, writeArchiveTemp } from '../integrations/export.js';

export interface ProjectDeps {
  config: Config;
  store: DocStore;
  projects: ProjectRepository;
  versions: VersionRepository;
  artifacts: ArtifactStore;
  jobs: BuildJobRepository;
  events: BuildEventRepository;
  runner: BuildRunner;
  usage: UsageService;
  audit: AuditService;
  previewsStop(projectId: string): Promise<void>;
}

/** Prepares a job for execution: enqueue + asynchronously run. */
export function queueBuildJob(deps: ProjectDeps, jobId: string): void {
  // Fire-and-forget. The runner updates the job state; cancellation is via the
  // running job registry.
  void (async () => {
    try {
      const job = await deps.jobs.get(jobId);
      if (!job) return;
      await deps.runner.execute(job);
    } catch (e) {
      // Fail the job so its state is terminal and events surface the error.
      const job = await deps.jobs.get(jobId);
      if (job && !['Failed', 'Cancelled', 'PreviewReady', 'Deployed'].includes(job.state)) {
        await deps.jobs.update(jobId, {
          state: 'Failed',
          errorSummary: e instanceof Error ? e.message.slice(0, 2000) : String(e),
        });
      }
    }
  })();
}

export function createProjectsRouter(deps: ProjectDeps): Router {
  const router = expressRouter();

  /** GET /api/v1/projects */
  router.get('/', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const query = ListProjectsQuerySchema.parse(
        req.query ?? {},
      );
      const result = await deps.projects.list(p.user.uid, query);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/projects */
  router.post('/', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const input = CreateProjectRequestSchema.parse(req.body ?? {});
      if (input.prompt.length > deps.config.quotas.maxPromptChars) {
        throw ApiError.tooLarge(
          `Prompt exceeds the ${deps.config.quotas.maxPromptChars}-character limit.`,
        );
      }
      const project = await deps.projects.create({
        ownerUid: p.user.uid,
        name: input.name,
        description: input.prompt,
        category: input.category,
        framework: input.framework,
        theme: input.theme,
      });

      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'project.create',
        resourceType: 'project',
        resourceId: project.id,
        metadata: { framework: project.framework, category: project.category },
      });

      if (input.autoStart) {
        const job = await deps.jobs.create({
          projectId: project.id,
          ownerUid: p.user.uid,
          operation: 'generate',
          instruction: input.prompt,
          baseVersionId: null,
          maxRepairAttempts: deps.config.quotas.maxRepairAttempts,
        });
        queueBuildJob(deps, job.id);
        res.status(201).json({ project, job });
      } else {
        res.status(201).json({ project, job: null });
      }
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/projects/:projectId */
  router.get('/:projectId', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const project = await deps.projects.getOwned(req.params.projectId, p.user.uid);
      res.json(project);
    } catch (e) {
      next(e);
    }
  });

  /** PATCH /api/v1/projects/:projectId */
  router.patch('/:projectId', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const input = UpdateProjectRequestSchema.parse(req.body ?? {});
      const project = await deps.projects.update(req.params.projectId, p.user.uid, input);
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'project.update',
        resourceType: 'project',
        resourceId: project.id,
      });
      res.json(project);
    } catch (e) {
      next(e);
    }
  });

  /** DELETE /api/v1/projects/:projectId */
  router.delete('/:projectId', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      await deps.projects.getOwned(req.params.projectId, p.user.uid);
      await deps.previewsStop(req.params.projectId);
      await deps.artifacts.deleteProject(req.params.projectId);
      await deps.versions.deleteAllForProject(req.params.projectId);
      await deps.store.deleteWhere(COLLECTIONS.deployments, [
        { field: 'projectId', op: '==', value: req.params.projectId },
      ]);
      // Remove per-job event streams first, then the jobs themselves.
      const jobRecords = await deps.jobs.listForProject(req.params.projectId, 200);
      for (const job of jobRecords.items ?? []) {
        await deps.events.deleteForJob(job.id);
      }
      await deps.jobs.deleteAllForProject(req.params.projectId);
      await deps.projects.delete(req.params.projectId, p.user.uid);
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'project.delete',
        resourceType: 'project',
        resourceId: req.params.projectId,
        outcome: 'success',
      });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/projects/:projectId/duplicate */
  router.post('/:projectId/duplicate', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const project = await deps.projects.getOwned(req.params.projectId, p.user.uid);
      if (!project.currentVersionId) {
        throw ApiError.conflict(
          'This project has no generated version yet. Run a build before duplicating.',
        );
      }
      const newProject = await deps.projects.create({
        ownerUid: p.user.uid,
        name: `${project.name} (copy)`,
        description: project.description,
        category: project.category,
        framework: project.framework,
        theme: project.theme,
      });
      // Copy artifact tree into a fresh version with a new id.
      const newVersionId = `ver_${crypto.randomBytes(12).toString('hex')}`;
      await deps.artifacts.copyVersion(newProject.id, project.currentVersionId, newVersionId);
      const manifest = await deps.artifacts.listFiles(newProject.id, newVersionId);
      const version = await deps.versions.create({
        id: newVersionId,
        projectId: newProject.id,
        parentVersionId: null,
        summary: `Duplicated from ${project.name} (${project.currentVersionId.slice(0, 8)}).`,
        origin: 'import',
        manifest: manifest.map((m) => ({ path: m.path, size: m.size, hash: m.hash })),
        createdBy: p.user.uid,
        buildStatus: project.lastBuildStatus,
        buildLogExcerpt: null,
      });
      await deps.projects.setCurrentVersion(
        newProject.id,
        p.user.uid,
        version.id,
        await deps.versions.latestOrdinal(newProject.id),
        project.lastBuildStatus,
      );
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'project.duplicate',
        resourceType: 'project',
        resourceId: newProject.id,
      });
      res.status(201).json({ project: newProject });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/projects/:projectId/export */
  router.get('/:projectId/export', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const project = await deps.projects.getOwned(req.params.projectId, p.user.uid);
      const versionId = project.currentVersionId;
      if (!versionId) throw ApiError.conflict('No generated version to export.');
      const files = await deps.artifacts.readAllFiles(project.id, versionId);
      const buffer = await buildZipArchive({
        project: { name: project.name, description: project.description },
        files,
        framework: project.framework,
        ownerLabel: p.user.uid,
        generatedAt: new Date().toISOString(),
      });
      const tempPath = await writeArchiveTemp(buffer);
      res.download(tempPath, `${safeFileName(project.name)}.zip`, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/projects/:projectId/versions */
  router.get('/:projectId/versions', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      await deps.projects.getOwned(req.params.projectId, p.user.uid);
      const limit = Number(req.query.limit ?? 50);
      const cursor = (req.query.cursor as string | undefined) ?? null;
      const result = await deps.versions.list(req.params.projectId, Math.min(limit, 100), cursor);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/projects/:projectId/versions/:versionId */
  router.get('/:projectId/versions/:versionId', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      await deps.projects.getOwned(req.params.projectId, p.user.uid);
      const version = await deps.versions.get(req.params.projectId, req.params.versionId);
      res.json(version);
    } catch (e) {
      next(e);
    }
  });

  /** POST /api/v1/projects/:projectId/versions/:versionId/restore */
  router.post('/:projectId/versions/:versionId/restore', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const project = await deps.projects.getOwned(req.params.projectId, p.user.uid);
      const base = await deps.versions.get(project.id, req.params.versionId);
      const files = await deps.artifacts.readAllFiles(project.id, base.id);
      const newVersionId = `ver_${crypto.randomBytes(12).toString('hex')}`;
      await deps.artifacts.writeFiles(
        project.id,
        newVersionId,
        files.map((f) => ({ path: f.path, content: f.content })),
      );
      const manifest = await deps.artifacts.listFiles(project.id, newVersionId);
      const version = await deps.versions.create({
        projectId: project.id,
        parentVersionId: base.id,
        summary: `Restored from version ${base.ordinal} (${base.id.slice(0, 8)}).`,
        origin: 'restore',
        manifest: manifest.map((m) => ({ path: m.path, size: m.size, hash: m.hash })),
        createdBy: p.user.uid,
        buildStatus: base.buildStatus,
        buildLogExcerpt: base.buildLogExcerpt,
      });
      await deps.projects.setCurrentVersion(
        project.id,
        p.user.uid,
        version.id,
        (await deps.versions.latestOrdinal(project.id)),
        version.buildStatus,
      );
      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'version.restore',
        resourceType: 'version',
        resourceId: version.id,
      });
      res.status(201).json({ version, project });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/projects/:projectId/files */
  router.get('/:projectId/files', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const project = await deps.projects.getOwned(req.params.projectId, p.user.uid);
      if (!project.currentVersionId) {
        res.json({ files: [], totalBytes: 0, fileCount: 0 });
        return;
      }
      const manifest = await deps.artifacts.listFiles(project.id, project.currentVersionId);
      const files = manifest.map((m) => ({
        path: m.path,
        size: m.size,
        language: languageOf(m.path),
        editable: editablePath(m.path),
      }));
      res.json({
        files,
        totalBytes: files.reduce((s, f) => s + f.size, 0),
        fileCount: files.length,
      });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/projects/:projectId/files/:filePath(*) */
  router.get('/:projectId/files/*', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const project = await deps.projects.getOwned(req.params.projectId, p.user.uid);
      if (!project.currentVersionId) throw ApiError.notFound('No version yet.');
      const relative = decodePathParam(req);
      const content = await deps.artifacts.readFile(project.id, project.currentVersionId, relative);
      res.json({
        path: relative,
        size: Buffer.byteLength(content, 'utf8'),
        language: languageOf(relative),
        editable: editablePath(relative),
        content,
        versionId: project.currentVersionId,
      });
    } catch (e) {
      next(e);
    }
  });

  /** PUT /api/v1/projects/:projectId/files/* */
  router.put('/:projectId/files/*', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const project = await deps.projects.getOwned(req.params.projectId, p.user.uid);
      const relative = decodePathParam(req);
      if (!editablePath(relative)) {
        throw ApiError.badRequest('This file cannot be edited directly.');
      }
      const body = req.body ?? {};
      const content = typeof body.content === 'string' ? body.content : '';
      if (content.length > 400_000) throw ApiError.tooLarge('File is too large to save.');
      const baseVersionId = typeof body.baseVersionId === 'string' ? body.baseVersionId : null;

      // Optimistic concurrency: the edit must be based on the current version.
      if (baseVersionId && baseVersionId !== project.currentVersionId) {
        throw ApiError.versionConflict(
          'The project changed since you opened this file. Reload the editor and try again.',
        );
      }

      const prev = project.currentVersionId;
      const newVersionId = `ver_${crypto.randomBytes(12).toString('hex')}`;
      if (prev) {
        await deps.artifacts.copyVersion(project.id, prev, newVersionId);
      }
      await deps.artifacts.writeFiles(project.id, newVersionId, [
        { path: relative, content },
      ]);
      const manifest = await deps.artifacts.listFiles(project.id, newVersionId);
      const version = await deps.versions.create({
        projectId: project.id,
        parentVersionId: prev,
        summary: `Manual edit: ${relative}`,
        origin: 'manual-edit',
        manifest: manifest.map((m) => ({ path: m.path, size: m.size, hash: m.hash })),
        createdBy: p.user.uid,
        buildStatus: 'running',
        buildLogExcerpt: null,
      });
      await deps.projects.setCurrentVersion(
        project.id,
        p.user.uid,
        version.id,
        await deps.versions.latestOrdinal(project.id),
        'running',
      );

      await deps.audit.record({
        actorUid: p.user.uid,
        action: 'project.saveFile',
        resourceType: 'project',
        resourceId: project.id,
        metadata: { path: relative, versionId: version.id },
      });

      res.status(201).json({
        path: relative,
        versionId: version.id,
        byteSize: Buffer.byteLength(content, 'utf8'),
      });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/v1/projects/:projectId/diff?from=&to= */
  router.get('/:projectId/diff', async (req, res, next) => {
    try {
      const p = req.principal;
      if (!p) throw ApiError.unauthorized();
      const project = await deps.projects.getOwned(req.params.projectId, p.user.uid);
      const fromVersionId = (req.query.from as string | undefined) ?? null;
      const toVersionId = (req.query.to as string | undefined) ?? project.currentVersionId;
      if (!toVersionId) throw ApiError.conflict('No version to diff against.');
      const base = fromVersionId
        ? await deps.versions.get(project.id, fromVersionId)
        : null;
      const [fromFiles, toFiles] = await Promise.all([
        base
          ? deps.artifacts.readAllFiles(project.id, base.id)
          : Promise.resolve([]),
        deps.artifacts.readAllFiles(project.id, toVersionId),
      ]);
      const fromMap = new Map<string, { content: string }>();
      for (const f of fromFiles) {
        const existing = fromMap.get(f.path);
        if (!existing || existing.content.length < f.content.length) fromMap.set(f.path, { content: f.content });
      }
      const toMap = new Map<string, { content: string }>();
      for (const f of toFiles) {
        toMap.set(f.path, { content: f.content });
      }
      // Compute a path-level diff (single file diff body is heavy; the manifest
      // diff entries plus per-file bodies are returned).
      const entries = diffPaths(fromMap, toMap);
      res.json({ fromVersionId: base?.id ?? null, toVersionId, entries });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

function languageOf(path: string): string {
  if (path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.mjs')) return 'javascript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.html')) return 'html';
  if (path.endsWith('.md')) return 'markdown';
  return 'text';
}

function editablePath(path: string): boolean {
  return (
    !path.includes('.env') &&
    !path.endsWith('.mjs') &&
    !path.includes('node_modules') &&
    !path.includes('.git') &&
    path !== 'package-lock.json'
  );
}

function decodePathParam(req: { path: string; params: Record<string, string> }): string {
  // Express captures the wildcard in req.params[0] when using "*".
  const layers = req.params['0'] ?? req.params[0] ?? req.path;
  const raw = String(layers).replace(/^\/+/, '');
  return decodeURIComponent(raw);
}

function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
}

function diffPaths(
  from: Map<string, { content: string }>,
  to: Map<string, { content: string }>,
): Array<{ path: string; change: 'added' | 'modified' | 'deleted'; additions: number; deletions: number }> {
  const out: Array<{ path: string; change: 'added' | 'modified' | 'deleted'; additions: number; deletions: number }> = [];
  const all = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...all].sort()) {
    const a = from.get(path);
    const b = to.get(path);
    if (!a && b) {
      out.push({ path, change: 'added', additions: b.content.split('\n').length, deletions: 0 });
    } else if (a && !b) {
      out.push({
        path,
        change: 'deleted',
        additions: 0,
        deletions: a.content.split('\n').length,
      });
    } else if (a && b && a.content !== b.content) {
      const added = countChangedLines(b.content, a.content);
      out.push({ path, change: 'modified', additions: added.added, deletions: added.deleted });
    }
  }
  return out;
}

function countChangedLines(toContent: string, fromContent: string): { added: number; deleted: number } {
  const a = fromContent.split('\n');
  const b = toContent.split('\n');
  // Simple LCS-free heuristic: count differing lines by length. Good enough for
  // a manifest-level change list.
  let added = 0;
  let deleted = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? '') !== (b[i] ?? '')) {
      if (b[i] !== undefined) added += 1;
      if (a[i] !== undefined) deleted += 1;
    }
  }
  return { added, deleted };
}