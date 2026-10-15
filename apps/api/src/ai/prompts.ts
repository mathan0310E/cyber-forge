import { z } from 'zod';
import {
  BriefAnalysisSchema,
  GenerationResultSchema,
  PatchSchema,
  RepairResultSchema,
  ReviewResultSchema,
  WebsiteSpecSchema,
  type BriefAnalysis,
  type GenerationResult,
  type Patch,
  type RepairResult,
  type ReviewResult,
  type WebsiteSpec,
} from '@wolf-forge/shared-types';
import { ApiError } from '../services/errors.js';
import { childLogger } from '../services/logger.js';
import type { ChatMessage } from '../providers/types.js';
import { parseModelJson } from './json.js';
import type { DispatchContext, ModelRouter } from './router/router.js';
import type { ModelRegistry } from './router/registry.js';

/**
 * A single structured generation stage.
 *
 * Structured output from free models is unreliable, so every stage:
 *  1. asks the model for JSON,
 *  2. validates with Zod,
 *  3. if validation fails, re-asks once with the validation errors attached,
 *  4. if it still fails, raises an actionable error.
 *
 * The repair budget is bounded by MAX_SCHEMA_REPAIRS and never loops.
 */
const MAX_SCHEMA_REPAIRS = 1;

export interface StageRun<T> {
  value: T;
  modelId: string;
  providerId: string;
  attempts: number;
}

export class StructuredStage {
  constructor(
    private readonly router: ModelRouter,
    private readonly registry: ModelRegistry,
  ) {}

  async run<S extends z.ZodTypeAny>(options: {
    role: 'planner' | 'codegen' | 'ui-refine' | 'debug' | 'review' | 'fallback';
    label: string;
    schema: S;
    system: string;
    user: string;
    maxTokens: number;
    temperature?: number;
    context: DispatchContext;
    signal?: AbortSignal;
    requiresJson?: boolean;
  }): Promise<StageRun<z.infer<S>>> {
    const log = childLogger({ stage: options.label, role: options.role });
    const messages: ChatMessage[] = [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ];

    let totalAttempts = 0;
    let lastIssues: string[] = [];
    let lastReason = 'unknown';
    let lastModel = '';

    for (let repair = 0; repair <= MAX_SCHEMA_REPAIRS; repair += 1) {
      const result = await this.router.dispatch(
        {
          role: options.role,
          messages,
          maxTokens: options.maxTokens,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          jsonMode: options.requiresJson ?? true,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        options.context,
      );
      totalAttempts += result.attempts;
      lastModel = result.modelId;

      const parsed = parseModelJson(result.text, {
        schema: options.schema,
        label: options.label,
      });

      if (parsed.ok) {
        log.info(
          { model: result.modelId, attempt: totalAttempts, repair },
          'structured stage succeeded',
        );
        return {
          value: parsed.value,
          modelId: result.modelId,
          providerId: result.providerId,
          attempts: totalAttempts,
        };
      }

      lastIssues = parsed.issues;
      lastReason = parsed.reason;
      log.warn({ model: result.modelId, repair, issues: parsed.issues }, 'schema validation failed');

      if (repair < MAX_SCHEMA_REPAIRS) {
        // Feed the validation errors back so the model can correct itself.
        messages.push({ role: 'assistant', content: result.text.slice(0, 6_000) });
        messages.push({
          role: 'user',
          content:
            `That response did not match the required JSON schema.\n\nProblems:\n` +
            `${parsed.issues.map((i) => `- ${i}`).join('\n')}\n\n` +
            'Reply with ONLY a single valid JSON object that satisfies the schema. ' +
            'No prose, no markdown fences, no comments.',
        });
      }
    }

    throw new ApiError(
      'provider_error',
      `The ${options.label} stage could not produce valid structured output after ` +
        `${MAX_SCHEMA_REPAIRS + 1} attempts with ${lastModel || 'the selected model'}. ${lastReason}`,
      {
        status: 502,
        retryable: true,
        details: { issues: lastIssues },
      },
    );
  }

  get freeOnly(): boolean {
    return this.registry.freeOnly;
  }
}

/* -------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* -------------------------------------------------------------------------- */

export const SYSTEM_PROMPTS = {
  planner: `You are the planning engine inside Wolf Forge, a website builder.
You convert a plain-language brief into a precise, buildable website specification.
Rules:
- Output ONLY a single JSON object matching the requested schema. No prose, no markdown.
- Choose sensible defaults instead of asking questions. Never request clarification.
- Keep the page count small and realistic (1-5 pages) for a first build.
- Only list dependencies that are genuinely needed; prefer none.
- Mark any invented text as sample content.
- Target framework: {FRAMEWORK}. Target theme: {THEME}.
- Accessibility and responsive behaviour must be stated explicitly.`,

  codegen: `You are the code generation engine inside Wolf Forge.
You write complete, working project files from a validated specification.
Rules:
- Output ONLY a single JSON object: {"summary": string, "files": [{"path": string, "content": string}], "dependencies": string[]}.
- Every file must be complete and runnable. Never emit placeholders like "..." or TODO.
- Paths are project-relative. Never use absolute paths, "..", or a leading slash.
- Never create .env files, node_modules, .git, or anything holding secrets.
- Use the exact dependency versions you declare. Keep the dependency list minimal.
- The project must build with the declared build command without network access to
  anything other than the package registry.
- Escape newlines correctly inside JSON strings.
- Content that is invented (names, testimonials, prices) must be obviously sample text.`,

  'ui-refine': `You are the UI refinement engine inside Wolf Forge.
You apply a user's visual or layout instruction to an existing project.
Rules:
- Output ONLY JSON: {"summary": string, "operations": [{"op":"write","path":string,"content":string,"reason":string} | {"op":"delete","path":string,"reason":string}]}.
- Change ONLY what the instruction requires. Preserve every unrelated file byte-for-byte.
- Never touch .env, node_modules, .git, or configuration holding credentials.
- Keep the project building. If you change imports, update package.json too.`,

  debug: `You are the build-repair engine inside Wolf Forge.
You receive a build failure and the files most likely responsible.
Rules:
- Output ONLY JSON: {"explanation": string, "operations": [...], "confidence": "low"|"medium"|"high"}.
- Produce the SMALLEST change that fixes the reported errors.
- Do not refactor, restyle, or "improve" unrelated code.
- If a dependency is missing, add it to package.json with a real published version.
- Never modify .env, node_modules, .git, or CI secrets.`,

  review: `You are the review engine inside Wolf Forge.
You inspect generated project files for defects that would break the build or the page.
Rules:
- Output ONLY JSON: {"verdict": "ok"|"concerns", "issues": [{"severity":"info"|"warning"|"error","path":string,"message":string}]}.
- Report only concrete, actionable problems: missing imports, undefined identifiers,
  unbalanced JSX, references to files that do not exist, invalid CSS syntax.
- Do not report style preferences. Do not invent issues to appear useful.`,
} as const;

export type PromptRole = keyof typeof SYSTEM_PROMPTS;

/** Fills the role-specific system prompt with the requested generation target. */
export function systemPromptForRole(
  role: PromptRole,
  framework: string | null,
  theme: string | null,
): string {
  return SYSTEM_PROMPTS[role]
    .replace('{FRAMEWORK}', framework ?? 'the scaffolded stack')
    .replace('{THEME}', theme ?? 'the scaffolded theme');
}

export function buildPlannerPrompt(input: {
  brief: string;
  framework: string;
  theme: string;
  category: string;
  projectName: string;
}): string {
  return [
    'Brief:',
    input.brief,
    '',
    `Project name: ${input.projectName}`,
    `Requested category: ${input.category}`,
    `Framework: ${input.framework}`,
    `Theme: ${input.theme}`,
    '',
    'Produce the specification JSON now.',
  ].join('\n');
}

export function buildCodegenPrompt(input: {
  spec: WebsiteSpec;
  filePlan: string[];
  dependencies: string[];
  maxFiles: number;
}): string {
  return [
    'Validated specification:',
    JSON.stringify(input.spec, null, 2),
    '',
    'Planned files:',
    input.filePlan.map((f) => `- ${f}`).join('\n') || '- (choose sensible paths)',
    '',
    'Declared dependencies:',
    input.dependencies.map((d) => `- ${d}`).join('\n') || '- none',
    '',
    `Produce at most ${input.maxFiles} files. Output the generation JSON now.`,
  ].join('\n');
}

export function buildRefinePrompt(input: {
  spec: WebsiteSpec | null;
  instruction: string;
  files: Array<{ path: string; content: string }>;
  maxFiles: number;
}): string {
  const manifest = input.files
    .slice(0, input.maxFiles)
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  return [
    'Current specification:',
    input.spec ? JSON.stringify(input.spec, null, 2) : '(not available)',
    '',
    'Current project files:',
    manifest,
    '',
    'User instruction:',
    input.instruction,
    '',
    'Produce the patch JSON now. Include a file in `operations` ONLY if it must change.',
  ].join('\n');
}

export function buildRepairPrompt(input: {
  errorOutput: string;
  diagnostics: string[];
  files: Array<{ path: string; content: string }>;
  attempt: number;
  previousAttempts: string[];
}): string {
  const manifest = input.files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');
  const history =
    input.previousAttempts.length > 0
      ? `\nPrevious repair attempts that did NOT fix it:\n${input.previousAttempts.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n`
      : '';

  return [
    `Build attempt ${input.attempt} failed.`,
    '',
    'Build output:',
    input.errorOutput,
    '',
    input.diagnostics.length > 0 ? `Parsed diagnostics:\n${input.diagnostics.join('\n')}\n` : '',
    history,
    'Relevant files:',
    manifest,
    '',
    'Produce the repair JSON now.',
  ].join('\n');
}

export function buildReviewPrompt(files: Array<{ path: string; content: string }>): string {
  return [
    'Project files:',
    files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n'),
    '',
    'Produce the review JSON now.',
  ].join('\n');
}

export const SCHEMAS = {
  analysis: BriefAnalysisSchema,
  spec: WebsiteSpecSchema,
  generation: GenerationResultSchema,
  patch: PatchSchema,
  repair: RepairResultSchema,
  review: ReviewResultSchema,
} as const;

export type { BriefAnalysis, GenerationResult, Patch, RepairResult, ReviewResult, WebsiteSpec };
