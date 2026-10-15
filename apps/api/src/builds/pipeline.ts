import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import type {
  BuildJob,
  PatchOperation,
  ProjectCategory,
  ProjectFramework,
  ProjectTheme,
  WebsiteSpec,
} from '@wolf-forge/shared-types';
import type { Config } from '../config/env.js';
import { BuildEventRepository, BuildJobRepository } from './job-store.js';
import { ProjectRepository, VersionRepository, type ProjectVersionRecord } from '../projects/repository.js';
import { runningJobs } from './event-bus.js';
import { BuildReporter, STAGE_PROGRESS } from './reporter.js';
import { PreviewRegistry } from './preview-registry.js';
import {
  parseDiagnostics,
  filesImplicatedByDiagnostics,
  formatDiagnosticsForPrompt,
} from './diagnostics.js';
import { ArtifactStore } from '../services/artifacts.js';
import { ApiError, cancellationError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';
import { getSandbox } from '../sandbox/index.js';
import { sanitizePackageJson } from '../sandbox/dependencies.js';
import { ModelRouter } from '../ai/router/router.js';
import {
  StructuredStage,
  buildCodegenPrompt,
  buildPlannerPrompt,
  buildRefinePrompt,
  buildRepairPrompt,
  systemPromptForRole,
} from '../ai/prompts.js';
import { scopedSchema } from '../ai/schemas.js';
import { buildScaffold } from '../ai/generator/scaffold.js';
import { generateFromTemplate } from '../ai/generator/builtin-generator.js';
import { specFromTemplate } from '../ai/generator/templates.js';
import {
  validatePatch,
  applyPatch as applyPatchInMemory,
  describePatch,
} from '../ai/patcher/apply.js';
import { COLLECTIONS, type DocStore } from '../db/store.js';

const require = createRequire(import.meta.url);

export interface PipelineDeps {
  config: Config;
  jobs: BuildJobRepository;
  events: BuildEventRepository;
  projects: ProjectRepository;
  versions: VersionRepository;
  artifacts: ArtifactStore;
  store: DocStore;
  router: ModelRouter;
  previews: PreviewRegistry;
}

export interface PipelineResult {
  versionId: string | null;
  previewUrl: string | null;
}

/** Marker recorded in version metadata when the built-in engine was used. */
export const BUILTIN_ENGINE_ID = 'wolf-forge:builtin-template';

/** Deterministic refinement applied when no free AI provider is configured. */
export function applyBuiltinRefinement(spec: WebsiteSpec, rawInstruction: string): string[] {
  const instruction = rawInstruction.toLowerCase();
  const changes: string[] = [];

  if (instruction.includes('theme')) {
    if (instruction.includes('light')) {
      spec.theme = 'light';
      spec.design.theme = 'light';
      spec.design.background = '#fbfaf7';
      spec.design.surface = '#ffffff';
      spec.design.text = '#16181d';
      spec.design.textMuted = '#5a6472';
      changes.push('switched theme to light');
    } else if (instruction.includes('dark')) {
      spec.theme = 'dark';
      spec.design.theme = 'dark';
      spec.design.background = '#0b0d12';
      spec.design.surface = '#141922';
      spec.design.text = '#f5f5f5';
      spec.design.textMuted = '#9aa4b2';
      changes.push('switched theme to dark');
    }
  }

  const accents: Record<string, [string, string]> = {
    lime: ['#d7f542', '#ff8a24'],
    cyan: ['#19d3f3', '#9b5cff'],
    orange: ['#ff8a24', '#19d3f3'],
    purple: ['#9b5cff', '#19d3f3'],
    green: ['#4ade80', '#ff8a24'],
    blue: ['#60a5fa', '#ff8a24'],
  };
  // The color word must appear in an imperative or design-targeted clause:
  // "make it lime", "change the buttons to orange", "lime accent",
  // "accent color lime", "primary lime". A bare phrase like "I like the
  // color blue" must not trigger an accent change.
  const sentences = instruction.split(/[.;,!?\n]/);
  const mentioned = Object.keys(accents).find((color) =>
    sentences.some((s) => {
      if (!s.includes(color)) return false;
      return (
        /\b(make|set|turn|switch)\b/.test(s) ||
        /\bchange\b.*\bto\b/.test(s) ||
        /\b(accent|primary|button|highlight)\b/.test(s)
      );
    }),
  );
  if (mentioned) {
    const [primary, accent] = accents[mentioned] ?? ['', ''];
    spec.design.primary = primary;
    spec.design.accent = accent;
    changes.push(`changed the primary accent to ${mentioned}`);
  }

  if (instruction.includes('sticky') && instruction.includes('nav')) {
    spec.interactions = [...(spec.interactions ?? []), 'sticky navigation header'];
    changes.push('made the navigation sticky');
  }

  return changes;
}

type RunProject = {
  id: string;
  category: ProjectCategory;
  framework: ProjectFramework;
  theme: ProjectTheme;
  name: string;
  description: string;
};

type DiagnosticLike = { severity: string };

export class GenerationPipeline {
  constructor(readonly deps: PipelineDeps) {}

  async run(job: BuildJob, signal: AbortSignal): Promise<PipelineResult> {
    const log = childLogger({ jobId: job.id, projectId: job.projectId });
    const report = new BuildReporter(job.id, this.deps.jobs, this.deps.events);
    runningJobs.register(job.id);

    try {
      const project = await this.deps.projects.getOwned(job.projectId, job.ownerUid);
      if (project.archived) {
        throw ApiError.forbidden('This project is archived. Unarchive it before building.');
      }

      const projectView: RunProject = {
        id: project.id,
        category: project.category,
        framework: project.framework,
        theme: project.theme,
        name: project.name,
        description: project.description,
      };

      if (job.operation === 'refine') {
        await report.state('Analyzing', 'Analyzing your refinement', STAGE_PROGRESS.Analyzing);
        await this.refine(job, projectView, report, signal);
      } else if (job.operation === 'rebuild') {
        await report.state('Analyzing', 'Rebuilding the current version', STAGE_PROGRESS.Analyzing);
        await report.state('Generating', 'Using current sources', STAGE_PROGRESS.Generating);
        if (!job.resultVersionId) throw ApiError.badRequest('No current version to rebuild.');
      } else {
        await report.state('Analyzing', 'Analyzing your request', STAGE_PROGRESS.Analyzing);
        await this.generate(job, projectView, report, signal);
      }

      if (signal.aborted) throw cancellationError();

      // generate/refine persist `resultVersionId` through the store; read it
      // back so downstream stages see the committed version.
      const refreshed = await this.deps.jobs.get(job.id);
      job = refreshed ?? job;
      if (!job.resultVersionId) throw ApiError.internal('No version to build.');

      await this.installAndBuild(job, report, signal);

      if (signal.aborted) throw cancellationError();

      await report.state('StartingPreview', 'Starting preview', STAGE_PROGRESS.StartingPreview);
      const previewPort = await getFreePort(4100, 4700);
      const preview = await this.deps.previews.start({
        projectId: job.projectId,
        versionId: job.resultVersionId!,
        ownerUid: job.ownerUid,
        workspaceDir: this.previewDir(job.id),
        command: 'node',
        args: ['.wolf-forge-serve.mjs'],
        port: previewPort,
        readyTimeoutMs: 30_000,
      });

      const previewUrl = `/preview/${preview.id}?token=${preview.accessToken}`;
      await report.state('PreviewReady', 'Preview ready', STAGE_PROGRESS.PreviewReady, {
        resultVersionId: job.resultVersionId,
      });
      await report.previewReady(previewUrl);
      await this.deps.projects.update(job.projectId, job.ownerUid, {
        previewUrl,
        lastBuildAt: new Date().toISOString(),
        lastError: null,
        lastBuildStatus: 'succeeded',
      });
      if (job.resultVersionId) {
        await this.deps.versions.updateBuildStatus(
          job.resultVersionId,
          'succeeded',
          'Build succeeded and preview is ready',
        );
      }

      log.info({ versionId: job.resultVersionId, previewId: preview.id }, 'pipeline finished');
      return { versionId: job.resultVersionId, previewUrl };
    } catch (e) {
      const aborted =
        signal.aborted || (e instanceof ApiError && e.code === 'bad_request' && e.status === 499);
      if (aborted) {
        await report.state('Cancelled', 'Build cancelled', STAGE_PROGRESS.Cancelled);
        await report.log('The build was stopped by the user. Cancelled jobs never claim success.');
        await this.deps.projects.update(job.projectId, job.ownerUid, {
          lastError: 'Build cancelled',
        });
        if (job.resultVersionId) {
          await this.deps.versions.updateBuildStatus(
            job.resultVersionId,
            'cancelled',
            'Cancelled',
          );
        }
        runningJobs.release(job.id);
        return { versionId: job.resultVersionId, previewUrl: null };
      }
      await this.fail(job, e, report, log);
      return { versionId: null, previewUrl: null };
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Generation                                                               */
  /* ------------------------------------------------------------------------ */

  private async generate(
    job: BuildJob,
    project: RunProject,
    report: BuildReporter,
    signal: AbortSignal,
  ): Promise<void> {
    const log = childLogger({ jobId: job.id, project: project.id });
    try {
      this.deps.router.registry().requireEligible('planner');
      await report.log('A free model is available. Using the AI pipeline for planning and generation.');
      await this.generateWithAi(job, project, report, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      const isMissing =
        e instanceof ApiError &&
        (e.code === 'provider_not_configured' ||
          e.code === 'no_eligible_model' ||
          e.code === 'free_only_violation');
      if (!isMissing) throw e;

      const reason = e instanceof ApiError ? e.message.split('.')[0] : 'No eligible model';
      await report.log(
        `${reason}. Falling back to the built-in template engine so your project is still real, ` +
          'complete and buildable. Configure an OpenRouter free key in the server environment to ' +
          'generate the same brief with AI instead.',
      );
      log.warn({ reason }, 'AI unavailable - using built-in template engine');
      await this.generateBuiltin(job, project, report, log);
    }
  }

  private async generateWithAi(
    job: BuildJob,
    project: RunProject,
    report: BuildReporter,
    signal: AbortSignal,
  ): Promise<void> {
    const stage = new StructuredStage(this.deps.router, this.deps.router.registry());
    const context = { userId: job.ownerUid, projectId: job.projectId, jobId: job.id };

    const seed = specFromTemplate({
      title: project.name,
      description: project.description,
      category: project.category,
      theme: project.theme,
      framework: project.framework,
    });

    const specResult = await stage.run({
      role: 'planner',
      label: 'website specification',
      schema: scopedSchema.spec,
      system: systemPromptForRole('planner', project.framework, project.theme),
      user: buildPlannerPrompt({
        brief: job.instruction ?? project.description,
        framework: project.framework,
        theme: project.theme,
        category: project.category,
        projectName: project.name,
      }),
      maxTokens: 4_000,
      temperature: 0.3,
      context,
      signal,
    });
    await report.modelSelected(specResult.providerId, specResult.modelId, 'planner');
    await this.deps.jobs.update(job.id, {
      model: specResult.modelId,
      provider: specResult.providerId,
    });
    await report.state('Planning', 'Planning the site', STAGE_PROGRESS.Planning);

    const spec = fuseSpec(seed, specResult.value as WebsiteSpec);

    await report.state('Generating', 'Generating source files', STAGE_PROGRESS.Generating);
    const generationResult = await stage.run({
      role: 'codegen',
      label: 'source generation',
      schema: scopedSchema.generation,
      system: systemPromptForRole('codegen', spec.framework, spec.theme),
      user: buildCodegenPrompt({
        spec,
        filePlan: [
          ...spec.pages.map((p) => `src/pages/${p.name}.tsx`),
          ...spec.components.map((c) => c.path),
        ],
        dependencies: spec.dependencies,
        maxFiles: this.deps.config.quotas.maxFilesPerProject,
      }),
      maxTokens: this.deps.config.quotas.maxOutputTokens,
      temperature: 0.3,
      context,
      signal,
    });
    await report.modelSelected(generationResult.providerId, generationResult.modelId, 'codegen');
    const gen = generationResult.value as {
      summary: string;
      files: Array<{ path: string; content: string }>;
      dependencies: string[];
    };
    const scaffold = buildScaffold(spec);
    const combined = mergeGeneratedWithScaffold(gen.files, scaffold);
    await this.writeVersion(
      job,
      combined,
      report,
      'generation',
      gen.summary,
      generationResult.modelId,
      'codegen',
      spec,
      logNull(),
    );
  }

  private async generateBuiltin(
    job: BuildJob,
    project: RunProject,
    report: BuildReporter,
    log: ReturnType<typeof childLogger>,
  ): Promise<void> {
    const spec = specFromTemplate({
      title: project.name,
      description: project.description,
      category: project.category,
      theme: project.theme,
      framework: project.framework,
    });
    await report.state('Planning', 'Planning the site structure', STAGE_PROGRESS.Planning);
    await report.state('Generating', 'Generating source files', STAGE_PROGRESS.Generating);
    const generated = generateFromTemplate({ spec, category: project.category });
    const scaffold = buildScaffold(spec);
    const combined = mergeGeneratedWithScaffold(generated.files, scaffold);
    await this.writeVersion(
      job,
      combined,
      report,
      'generation',
      generated.summary,
      BUILTIN_ENGINE_ID,
      'builtin-template',
      spec,
      log,
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Refinement                                                               */
  /* ------------------------------------------------------------------------ */

  private async refine(
    job: BuildJob,
    project: RunProject,
    report: BuildReporter,
    signal: AbortSignal,
  ): Promise<void> {
    if (!job.baseVersionId) throw ApiError.badRequest('A base version is required for refinement.');
    const log = childLogger({ jobId: job.id });

    const base = await this.deps.versions.get(job.projectId, job.baseVersionId);
    const currentFiles = await this.deps.artifacts.readAllFiles(job.projectId, base.id);

    try {
      this.deps.router.registry().requireEligible('ui-refine');
    } catch (e) {
      const isMissing =
        e instanceof ApiError &&
        (e.code === 'provider_not_configured' ||
          e.code === 'no_eligible_model' ||
          e.code === 'free_only_violation');
      if (!isMissing) throw e;
      await this.refineBuiltin(job, base, report, project);
      return;
    }

    await report.state('Planning', 'Planning the edit', STAGE_PROGRESS.Planning);
    const stage = new StructuredStage(this.deps.router, this.deps.router.registry());
    const patchResult = await stage.run({
      role: 'ui-refine',
      label: 'refinement patch',
      schema: scopedSchema.patch,
      system: systemPromptForRole('ui-refine', null, null),
      user: buildRefinePrompt({
        spec: base.specJson ? (JSON.parse(base.specJson) as WebsiteSpec) : null,
        instruction: job.instruction ?? '',
        files: currentFiles,
        maxFiles: this.deps.config.quotas.maxFilesPerProject,
      }),
      maxTokens: 6_000,
      temperature: 0.3,
      context: { userId: job.ownerUid, projectId: job.projectId, jobId: job.id },
      signal,
    });
    await report.modelSelected(patchResult.providerId, patchResult.modelId, 'ui-refine');

    const patch = patchResult.value as { summary: string; operations: PatchOperation[] };
    const specSeed =
      (base.specJson ? (JSON.parse(base.specJson) as WebsiteSpec) : null) ??
      specFromTemplate({
        title: project.name,
        description: project.description,
        category: project.category,
        theme: project.theme,
        framework: project.framework,
      });
    const scaffold = buildScaffold(specSeed);

    const current = new Map(currentFiles.map((f) => [f.path, f.content]));
    const validated = validatePatch(patch.operations, {
      existingPaths: new Set(current.keys()),
      maxTotalBytes: this.deps.config.quotas.maxSourceBytes,
      ownedPaths: new Set(scaffold.files.filter((f) => f.owned).map((f) => f.path)),
      allowDelete: false,
    });
    const next = applyPatchInMemory(current, validated);

    // Re-assert scaffold-owned files from the base snapshot so a patch can
    // never corrupt the toolchain.
    for (const f of scaffold.files) {
      if (f.owned && current.has(f.path)) next.set(f.path, current.get(f.path)!);
    }

    const combined = [...next.entries()].map(([filePath, content]) => ({
      path: filePath,
      content,
    }));
    await this.writeVersion(
      job,
      combined,
      report,
      'refinement',
      patch.summary || 'Applied user refinement',
      patchResult.modelId,
      'ui-refine',
      specSeed,
      log,
    );
  }

  private async refineBuiltin(
    job: BuildJob,
    base: ProjectVersionRecord,
    report: BuildReporter,
    project: RunProject,
  ): Promise<void> {
    const spec = base.specJson ? (JSON.parse(base.specJson) as WebsiteSpec) : null;
    if (!spec) throw ApiError.internal('No specification stored for this version.');

    const changes = applyBuiltinRefinement(spec, job.instruction ?? '');
    if (changes.length === 0) {
      throw ApiError.badRequest(
        'Without an AI provider, the built-in engine supports a limited set of edits: ' +
          'change the accent (lime, cyan, orange, purple, green, blue), switch between ' +
          'light and dark theme, or make the navigation sticky. Configure an OpenRouter ' +
          'free key to apply arbitrary refinements.',
      );
    }

    await report.log(
      'No free model available for refinement; applying the deterministic edit.',
    );
    await report.state('Planning', 'Planning the edit', STAGE_PROGRESS.Planning);
    await report.state('Generating', 'Applying the edit', STAGE_PROGRESS.Generating);
    const generated = generateFromTemplate({ spec, category: project.category });
    const scaffold = buildScaffold(spec);
    const combined = mergeGeneratedWithScaffold(generated.files, scaffold);
    await this.writeVersion(
      job,
      combined,
      report,
      'refinement',
      `Applied refinement: ${changes.join(', ')}.`,
      BUILTIN_ENGINE_ID,
      'builtin-template',
      spec,
      childLogger({}),
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Version commit                                                           */
  /* ------------------------------------------------------------------------ */

  private async writeVersion(
    job: BuildJob,
    files: Array<{ path: string; content: string }>,
    report: BuildReporter,
    origin: 'generation' | 'refinement' | 'restore',
    summary: string,
    model: string | null,
    role: string | null,
    spec: WebsiteSpec | null,
    log: ReturnType<typeof childLogger>,
  ): Promise<string> {
    const versionId = `ver_${cryptoRandom()}`;
    const manifest = await this.deps.artifacts.writeFiles(job.projectId, versionId, files);
    await this.deps.store.set(COLLECTIONS.versions, versionId, {
      id: versionId,
      projectId: job.projectId,
      parentVersionId: job.baseVersionId,
      ordinal: 0,
      summary: summary.slice(0, 600),
      origin,
      fileCount: manifest.length,
      totalBytes: manifest.reduce((s, m) => s + m.size, 0),
      buildStatus: 'running',
      buildLogExcerpt: null,
      createdAt: new Date().toISOString(),
      model,
      taskRole: role,
      manifest,
      createdBy: job.ownerUid,
      specJson: spec ? JSON.stringify(spec) : null,
    });
    for (const f of files) {
      await report.fileWritten(f.path, Buffer.byteLength(f.content, 'utf8'));
    }
    await this.deps.jobs.update(job.id, {
      resultVersionId: versionId,
      ...(model === BUILTIN_ENGINE_ID
        ? { model: BUILTIN_ENGINE_ID, provider: 'builtin' }
        : {}),
    });
    await this.deps.projects.setCurrentVersion(
      job.projectId,
      job.ownerUid,
      versionId,
      await this.deps.versions.latestOrdinal(job.projectId),
      'running',
    );
    log?.info?.({ versionId }, 'version committed');
    return versionId;
  }

  /* ------------------------------------------------------------------------ */
  /* Install + build + repair                                                 */
  /* ------------------------------------------------------------------------ */

  private baseDir(jobId: string): string {
    return path.resolve(this.deps.config.env.ARTIFACT_STORAGE_PATH, 'workspaces', jobId);
  }

  private workDir(jobId: string): string {
    return path.join(this.baseDir(jobId), 'work');
  }

  private previewDir(jobId: string): string {
    return path.join(this.baseDir(jobId), 'preview');
  }

  private async installAndBuild(
    job: BuildJob,
    report: BuildReporter,
    signal: AbortSignal,
  ): Promise<{ built: boolean }> {
    const sandbox = getSandbox();
    const workDir = this.workDir(job.id);
    const previewDir = this.previewDir(job.id);
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(previewDir, { recursive: true });

    const versionId = job.resultVersionId;
    if (!versionId) throw ApiError.internal('No version to build.');
    const manifest = await this.deps.artifacts.materialize(job.projectId, versionId, workDir);

    const pkgRaw = await readMaybe(workDir, 'package.json');
    if (pkgRaw) {
      const sanitized = sanitizePackageJson(pkgRaw);
      await fs.writeFile(path.join(workDir, 'package.json'), sanitized, 'utf8');
    }

    const hasPackage = pkgRaw !== null;
    if (hasPackage) {
      await report.state('Installing', 'Installing dependencies', STAGE_PROGRESS.Installing);
      const install = await sandbox.exec({
        workspaceDir: workDir,
        command: 'npm',
        args: ['install', '--no-audit', '--no-fund'],
        timeoutMs: this.deps.config.env.SANDBOX_INSTALL_TIMEOUT_MS,
        signal,
        label: 'npm install',
      });
      if (install.exitCode !== 0 || install.timedOut) {
        if (install.cancelled) throw cancellationError();
        throw ApiError.buildFailed(
          install.timedOut
            ? `Dependency installation exceeded the ${Math.round(
                this.deps.config.env.SANDBOX_INSTALL_TIMEOUT_MS / 1000,
              )}s limit.`
            : 'Installing dependencies failed. The generated package set is likely wrong.',
          { output: install.output.slice(0, 2000) },
        );
      }
      await report.log('Dependencies installed.');
      await copyTreeFiltered(workDir, previewDir, ['node_modules']);
    } else {
      await copyTreeFiltered(workDir, previewDir, []);
    }

    const hasBuildScript = pkgRaw ? hasBuildScriptField(pkgRaw) : false;
    if (!hasBuildScript) {
      await report.log('No build step required - serving static files directly.');
      return { built: true };
    }

    await report.state('Building', 'Building the project', STAGE_PROGRESS.Building);

    const maxRepairs = job.maxRepairAttempts;
    let attempt = 0;
    const repairHistory: string[] = [];

    for (;;) {
      attempt += 1;
      if (signal.aborted) throw cancellationError();

      const run = await sandbox.exec({
        workspaceDir: workDir,
        command: 'npm',
        args: ['run', 'build'],
        timeoutMs: this.deps.config.env.SANDBOX_BUILD_TIMEOUT_MS,
        signal,
        label: `npm run build (attempt ${attempt})`,
      });

      const outputExists = await pathExists(path.join(workDir, 'dist'));
      const diagnostics = parseDiagnostics(run.output);
      const succeeded = buildSucceeded2(run.exitCode, diagnostics, outputExists);

      for (const d of diagnostics) {
        await report.diagnostic(d.severity, d.message, {
          file: d.file,
          line: d.line,
          code: d.code,
        });
      }

      if (succeeded) {
        const exercise = await exerciseSite(path.join(previewDir, 'dist'));
        if (exercise) {
          await report.log(`Smoke check passed: ${exercise.pages} route(s) return HTTP 200.`);
        }
        await report.log(`Build succeeded (attempt ${attempt}, ${run.durationMs}ms).`);
        await copyTreeFiltered(workDir, previewDir, ['node_modules', 'dist']);
        return { built: true };
      }

      if (run.cancelled) throw cancellationError();
      if (signal.aborted) throw cancellationError();

      if (attempt > maxRepairs) {
        const excerpt = diagnostics
          .slice(0, 12)
          .map((d) => `${d.file ?? '(project)'}: ${d.message}`)
          .join('; ');
        throw ApiError.buildFailed(
          `The build failed and all ${maxRepairs} repair attempt${maxRepairs === 1 ? '' : 's'} were used. ` +
            `Last errors: ${excerpt.slice(0, 400)}`,
          {
            output: run.output.slice(0, 3000),
            diagnostics: formatDiagnosticsForPrompt(diagnostics),
          },
        );
      }

      await report.state(
        'Repairing',
        `Repairing build errors (attempt ${attempt} of ${maxRepairs})`,
        STAGE_PROGRESS.Repairing,
      );

      const available = new Set(manifest.map((m) => m.path));
      const relevant = filesImplicatedByDiagnostics(diagnostics, available);
      const softwarePaths =
        relevant.length > 0
          ? relevant
          : [...available].filter((p) => p.startsWith('src/')).slice(0, 12);
      const fileContents = await this.readRelevant(job, versionId, softwarePaths);

      const repair = await this.attemptRepair(job, report, signal, {
        output: run.output.slice(0, 6000),
        diagnostics,
        files: fileContents,
        attempt,
        previous: repairHistory,
      });
      repairHistory.push(repair.summary);

      const existingPaths = new Set(await filesOnDisk(workDir));
      const validated = validatePatch(repair.operations, {
        existingPaths,
        maxTotalBytes: this.deps.config.quotas.maxSourceBytes,
        allowDelete: true,
      });
      await applyPatchToDisk(workDir, validated);
      await copyTreeFiltered(workDir, previewDir, ['node_modules', 'dist']);
      await report.log(`Repair applied: ${describePatch(validated)}`);
      await this.deps.jobs.update(job.id, { repairAttempts: attempt });
    }
  }

  private async attemptRepair(
    job: BuildJob,
    report: BuildReporter,
    signal: AbortSignal,
    input: {
      output: string;
      diagnostics: ReturnType<typeof parseDiagnostics>;
      files: Array<{ path: string; content: string }>;
      attempt: number;
      previous: string[];
    },
  ): Promise<{ operations: PatchOperation[]; summary: string }> {
    if (job.model === BUILTIN_ENGINE_ID) {
      throw ApiError.buildFailed(
        'The built-in template produced a build error that Wolf Forge cannot repair without an AI ' +
          'provider. Fix the reported file manually or regenerate the project.',
        { diagnostics: formatDiagnosticsForPrompt(input.diagnostics) },
      );
    }

    const stage = new StructuredStage(this.deps.router, this.deps.router.registry());
    const result = await stage.run({
      role: 'debug',
      label: 'build repair',
      schema: scopedSchema.repair,
      system: systemPromptForRole('debug', null, null),
      user: buildRepairPrompt({
        errorOutput: input.output,
        diagnostics: formatDiagnosticsForPrompt(input.diagnostics),
        files: input.files,
        attempt: input.attempt,
        previousAttempts: input.previous,
      }),
      maxTokens: 4_000,
      temperature: 0.2,
      context: { userId: job.ownerUid, projectId: job.projectId, jobId: job.id },
      signal,
    });
    const repair = result.value as { explanation: string; operations: PatchOperation[]; confidence: string };
    await report.modelSelected(result.providerId, result.modelId, 'debug');
    await report.log(`Debug model suggested a fix (${String(repair.confidence)} confidence).`);
    return {
      operations: repair.operations ?? [],
      summary: repair.explanation.slice(0, 300),
    };
  }

  private async readRelevant(
    job: BuildJob,
    versionId: string,
    relevant: string[],
  ): Promise<Array<{ path: string; content: string }>> {
    const out: Array<{ path: string; content: string }> = [];
    for (const p of relevant.slice(0, 12)) {
      try {
        out.push({
          path: p,
          content: await this.deps.artifacts.readFile(job.projectId, versionId, p),
        });
      } catch {
        /* best-effort */
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------------ */
  /* Failure handling                                                         */
  /* ------------------------------------------------------------------------ */

  private async fail(
    job: BuildJob,
    error: unknown,
    report: BuildReporter,
    log: ReturnType<typeof childLogger>,
  ): Promise<void> {
    const normalized = normalizeJobError(error);
    await report.error(normalized.message, normalized.code);
    await this.deps.jobs.update(job.id, {
      errorSummary: normalized.message.slice(0, 2000),
      errorCode: normalized.code,
    });
    await this.deps.projects.update(job.projectId, job.ownerUid, {
      lastError: normalized.message.slice(0, 500),
      lastBuildStatus: 'failed',
    });
    if (job.resultVersionId) {
      await this.deps.versions.updateBuildStatus(
        job.resultVersionId,
        'failed',
        normalized.message.slice(0, 2000),
      );
    }
    try {
      await report.state('Failed', 'Build failed', STAGE_PROGRESS.Failed);
    } catch {
      /* job may already be terminal */
    }
    runningJobs.release(job.id);
    log.warn({ code: normalized.code }, 'pipeline ended in failure');
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function cryptoRandom(): string {
  return require('node:crypto').randomBytes(12).toString('hex');
}

function logNull(): ReturnType<typeof childLogger> {
  return childLogger({});
}

function mergeGeneratedWithScaffold(
  generated: Array<{ path: string; content: string }>,
  scaffold: ReturnType<typeof buildScaffold>,
): Array<{ path: string; content: string }> {
  const owned = new Map(scaffold.files.filter((f) => f.owned).map((f) => [f.path, f.content]));
  const content = new Map<string, string>();
  for (const f of scaffold.files) content.set(f.path, f.content);
  for (const f of generated) content.set(f.path, f.content);
  for (const [p, c] of owned) content.set(p, c);
  return [...content.entries()].map(([filePath, value]) => ({ path: filePath, content: value }));
}

function fuseSpec(seed: WebsiteSpec, modelSpec: WebsiteSpec): WebsiteSpec {
  return {
    ...modelSpec,
    framework: seed.framework,
    theme: seed.theme,
    design: { ...seed.design, ...modelSpec.design },
    pages: modelSpec.pages.length > 0 ? modelSpec.pages : seed.pages,
  };
}

function normalizeJobError(e: unknown): { message: string; code: string } {
  if (e instanceof ApiError) return { message: e.message, code: e.code };
  return { message: e instanceof Error ? e.message : String(e), code: 'internal_error' };
}

export function buildSucceeded2(
  exitCode: number,
  diagnostics: DiagnosticLike[],
  outputExists: boolean,
): boolean {
  if (exitCode !== 0 || !outputExists) return false;
  return !diagnostics.some((d) => d.severity === 'error');
}

async function readMaybe(dir: string, file: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(dir, file), 'utf8');
  } catch {
    return null;
  }
}

export function hasBuildScriptField(pkgJson: string): boolean {
  try {
    const parsed = JSON.parse(pkgJson) as { scripts?: Record<string, string> };
    return typeof parsed.scripts?.build === 'string';
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a loopback port in [min, max] that is free at check time. A server
 * bound to it (even briefly) reserves the number, avoiding collisions with
 * stale preview processes after an API restart.
 */
export async function getFreePort(min: number, max: number): Promise<number> {
  const { createServer } = await import('node:net');
  const tries = 40;
  for (let i = 0; i < tries; i += 1) {
    const candidate = min + Math.floor(Math.random() * (max - min + 1));
    const ok = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => {
        probe.close(() => resolve(true));
      });
      setTimeout(() => {
        try {
          probe.close();
        } catch {
          /* noop */
        }
        resolve(false);
      }, 1_500).unref?.();
    });
    if (ok) return candidate;
  }
  throw ApiError.internal('Could not allocate a free port for the preview server.');
}

async function copyTreeFiltered(src: string, dest: string, copyDirs: string[]): Promise<void> {
  const skip = new Set(['.git', '.wolf-forge']);
  for (const d of copyDirs) skip.delete(d);
  skip.add('node_modules');
  skip.add('dist');
  for (const d of copyDirs) skip.delete(d);
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTreeFiltered(from, to, []);
    } else {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }
}

async function filesOnDisk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, base: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, base);
      else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  };
  await walk(dir, dir);
  return out;
}

async function applyPatchToDisk(
  workDir: string,
  patch: ReturnType<typeof validatePatch>,
): Promise<void> {
  for (const op of patch.operations) {
    const target = path.resolve(workDir, op.path);
    const prefix = path.resolve(workDir) + path.sep;
    if (!target.startsWith(prefix)) continue;
    if (op.op === 'write') {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, op.content, 'utf8');
    } else {
      await fs.rm(target, { force: true });
    }
  }
}

/** Serves the built dist and verifies the entry routes answer correctly. */
async function exerciseSite(distDir: string): Promise<{ pages: number } | null> {
  const { createServer } = await import('node:http');
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.slice(-1) === '/') pathname += 'index.html';
      try {
        const content = await fs.readFile(path.join(distDir, pathname));
        const type = pathname.endsWith('.html')
          ? 'text/html'
          : pathname.endsWith('.js')
            ? 'text/javascript'
            : 'text/plain';
        res.writeHead(200, { 'Content-Type': type });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      Promise.all(
        ['/', '/index.html'].map((p) =>
          fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.status).catch(() => 500),
        ),
      )
        .then((codes) => {
          server.close();
          resolve(codes.every((c) => c === 200) ? { pages: codes.length } : null);
        })
        .catch(() => {
          server.close();
          resolve(null);
        });
    });
  });
}