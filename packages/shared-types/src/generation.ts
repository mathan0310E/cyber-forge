import { z } from 'zod';
import { ProjectCategory, ProjectFramework, ProjectTheme } from './projects.js';

/**
 * Path safety is enforced here, in one place, because every file operation
 * (AI patches, manual edits, ZIP export, git push) flows through it.
 */
export const SAFE_PATH_REGEX = /^[A-Za-z0-9._@/+-]+$/;

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 240) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (path.includes('\\')) return false;
  if (!SAFE_PATH_REGEX.test(path)) return false;
  const segments = path.split('/');
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..');
}

export const SafeRelativePath = z
  .string()
  .min(1)
  .max(240)
  .refine(isSafeRelativePath, { message: 'Unsafe or invalid file path' });

/** File paths the generator is never allowed to touch, anywhere in a project. */
export const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.(?!example$)[^/]*$/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)id_rsa/i,
  /serviceAccount.*\.json$/i,
  /(^|\/)\.wolf-forge(\/|$)/i,
];

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATH_PATTERNS.some((re) => re.test(path));
}

export const GeneratedFileSchema = z.object({
  path: SafeRelativePath,
  content: z.string().max(200_000),
});
export type GeneratedFile = z.infer<typeof GeneratedFileSchema>;

export const PatchOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('write'),
    path: SafeRelativePath,
    content: z.string().max(200_000),
    reason: z.string().max(400).optional(),
  }),
  z.object({
    op: z.literal('delete'),
    path: SafeRelativePath,
    reason: z.string().max(400).optional(),
  }),
]);
export type PatchOperation = z.infer<typeof PatchOperationSchema>;

export const PatchSchema = z.object({
  summary: z.string().min(1).max(600),
  operations: z.array(PatchOperationSchema).min(1).max(60),
});
export type Patch = z.infer<typeof PatchSchema>;

/** Stage A output: what the engine understood from the brief. */
export const BriefAnalysisSchema = z.object({
  category: ProjectCategory,
  intent: z.string().min(1).max(600),
  audience: z.string().max(400).default('general visitors'),
  keyFeatures: z.array(z.string().max(200)).max(20).default([]),
  designPreferences: z.array(z.string().max(200)).max(20).default([]),
  constraints: z.array(z.string().max(200)).max(20).default([]),
  /** Things the brief left out that the planner should decide sensibly. */
  assumptions: z.array(z.string().max(200)).max(20).default([]),
  requestedIntegrations: z.array(z.string().max(80)).max(10).default([]),
});
export type BriefAnalysis = z.infer<typeof BriefAnalysisSchema>;

export const SitePageSchema = z.object({
  name: z.string().min(1).max(80),
  route: z.string().min(1).max(120),
  purpose: z.string().min(1).max(400),
  sections: z.array(z.string().max(120)).max(20).default([]),
});
export type SitePage = z.infer<typeof SitePageSchema>;

export const DesignTokensSchema = z.object({
  background: z.string().max(40).default('#0b0d12'),
  surface: z.string().max(40).default('#141922'),
  text: z.string().max(40).default('#f5f5f5'),
  textMuted: z.string().max(40).default('#9aa4b2'),
  primary: z.string().max(40).default('#19d3f3'),
  accent: z.string().max(40).default('#ff8a24'),
  headingFont: z.string().max(120).default('system-ui, sans-serif'),
  bodyFont: z.string().max(120).default('system-ui, sans-serif'),
  radius: z.string().max(20).default('12px'),
  theme: ProjectTheme.default('dark'),
});
export type DesignTokens = z.infer<typeof DesignTokensSchema>;

export const ComponentPlanSchema = z.object({
  name: z.string().min(1).max(80),
  path: z.string().min(1).max(160),
  responsibility: z.string().min(1).max(400),
  props: z.array(z.string().max(120)).max(20).default([]),
});
export type ComponentPlan = z.infer<typeof ComponentPlanSchema>;

/** Stage B output: the validated website specification. */
export const WebsiteSpecSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(600),
  audience: z.string().min(1).max(400),
  framework: ProjectFramework.default('vite-react-ts'),
  theme: ProjectTheme.default('dark'),
  pages: z.array(SitePageSchema).min(1).max(12),
  design: DesignTokensSchema,
  components: z.array(ComponentPlanSchema).max(40).default([]),
  dataRequirements: z.array(z.string().max(300)).max(20).default([]),
  interactions: z.array(z.string().max(300)).max(20).default([]),
  responsive: z.array(z.string().max(300)).max(20).default([]),
  accessibility: z.array(z.string().max(300)).max(20).default([]),
  filePlan: z.array(z.string().max(160)).max(120).default([]),
  dependencies: z.array(z.string().max(120)).max(40).default([]),
  validationCriteria: z.array(z.string().max(300)).max(20).default([]),
  /** Content invented by the model is labelled so the UI can disclose it. */
  sampleContent: z.boolean().default(true),
});
export type WebsiteSpec = z.infer<typeof WebsiteSpecSchema>;

/** Stage C output. */
export const GenerationResultSchema = z.object({
  summary: z.string().max(600),
  files: z.array(GeneratedFileSchema).min(1).max(120),
  dependencies: z.array(z.string().max(120)).max(40).default([]),
});
export type GenerationResult = z.infer<typeof GenerationResultSchema>;

/** Result of a bounded repair attempt. */
export const RepairResultSchema = z.object({
  explanation: z.string().max(1200),
  operations: z.array(PatchOperationSchema).max(30),
  /** The model's own confidence, surfaced to the user but never trusted blindly. */
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type RepairResult = z.infer<typeof RepairResultSchema>;

export const ReviewResultSchema = z.object({
  verdict: z.enum(['ok', 'concerns']),
  issues: z
    .array(
      z.object({
        severity: z.enum(['info', 'warning', 'error']),
        path: z.string().max(240).optional(),
        message: z.string().max(400),
      }),
    )
    .max(30)
    .default([]),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
