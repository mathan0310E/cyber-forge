import { z } from 'zod';

export const ProjectCategory = z.enum([
  'portfolio',
  'business',
  'landing-page',
  'blog',
  'ecommerce',
  'saas-dashboard',
  'education',
  'event',
  'documentation',
  'custom',
]);
export type ProjectCategory = z.infer<typeof ProjectCategory>;

export const PROJECT_CATEGORY_LABELS: Record<ProjectCategory, string> = {
  portfolio: 'Portfolio',
  business: 'Business website',
  'landing-page': 'Landing page',
  blog: 'Blog',
  ecommerce: 'E-commerce storefront',
  'saas-dashboard': 'SaaS dashboard',
  education: 'Educational website',
  event: 'Event registration',
  documentation: 'Documentation site',
  custom: 'Custom application',
};

/**
 * Supported output stacks. Wolf Forge deliberately supports ONE stack well
 * rather than pretending arbitrary frameworks work: the sandbox has a verified
 * install+build recipe for each entry below, and nothing else is offered.
 */
export const ProjectFramework = z.enum(['vite-react-ts', 'static-html']);
export type ProjectFramework = z.infer<typeof ProjectFramework>;

export const FRAMEWORK_LABELS: Record<ProjectFramework, string> = {
  'vite-react-ts': 'React + Vite + TypeScript',
  'static-html': 'Static HTML / CSS / JS',
};

export const FrameworkInfoSchema = z.object({
  id: ProjectFramework,
  label: z.string(),
  description: z.string(),
  default: z.boolean(),
  /** How the sandbox builds this framework. Surfaced in the UI, not invented. */
  buildCommand: z.string(),
  outputDir: z.string(),
  /** Whether a static host can serve the build output directly. */
  staticHostable: z.boolean(),
});
export type FrameworkInfo = z.infer<typeof FrameworkInfoSchema>;

export const ProjectTheme = z.enum(['dark', 'light', 'auto']);
export type ProjectTheme = z.infer<typeof ProjectTheme>;

export const PROJECT_STATUSES = ['draft', 'generating', 'ready', 'failed', 'archived'] as const;
export const ProjectStatus = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const BuildStatus = z.enum(['never', 'succeeded', 'failed', 'running', 'cancelled']);
export type BuildStatus = z.infer<typeof BuildStatus>;

export const ProjectSchema = z.object({
  id: z.string(),
  ownerUid: z.string(),
  name: z.string(),
  description: z.string(),
  category: ProjectCategory,
  framework: ProjectFramework,
  theme: ProjectTheme,
  status: ProjectStatus,
  lastBuildStatus: BuildStatus,
  currentVersionId: z.string().nullable(),
  versionCount: z.number().int().nonnegative(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastBuildAt: z.string().nullable(),
  /** Public preview URL once a preview has actually reported ready. */
  previewUrl: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectRequestSchema = z.object({
  name: z.string().trim().min(1, 'Give your project a name').max(120),
  description: z.string().trim().max(2000).default(''),
  prompt: z.string().trim().min(10, 'Describe the website in at least 10 characters').max(8000),
  category: ProjectCategory.default('custom'),
  framework: ProjectFramework.default('vite-react-ts'),
  theme: ProjectTheme.default('dark'),
  /** Start generating as soon as the project is created. */
  autoStart: z.boolean().default(true),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    theme: z.enum(['dark', 'light', 'auto']).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const ListProjectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
  search: z.string().trim().max(120).optional(),
  sort: z.enum(['updatedAt', 'createdAt', 'name']).default('updatedAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  includeArchived: z.coerce.boolean().default(false),
  status: ProjectStatus.optional(),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;

/** A single file inside a project version. */
export const ProjectFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  language: z.string(),
  /** Present for user-created or AI-created files; absent for binary assets. */
  editable: z.boolean(),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export const ProjectFileContentSchema = ProjectFileSchema.extend({
  content: z.string(),
  /** Version this content was read from; clients echo it back on write. */
  versionId: z.string(),
});
export type ProjectFileContent = z.infer<typeof ProjectFileContentSchema>;

export const ProjectFileTreeSchema = z.object({
  files: z.array(ProjectFileSchema),
  totalBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
});
export type ProjectFileTree = z.infer<typeof ProjectFileTreeSchema>;

export const WriteFileRequestSchema = z.object({
  content: z.string().max(400_000),
  /** Optimistic concurrency: the versionId the edit was based on. */
  baseVersionId: z.string(),
  message: z.string().trim().max(200).optional(),
});
export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;

export const ProjectVersionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  parentVersionId: z.string().nullable(),
  ordinal: z.number().int().positive(),
  summary: z.string(),
  origin: z.enum(['generation', 'refinement', 'manual-edit', 'restore', 'import']),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  buildStatus: BuildStatus,
  buildLogExcerpt: z.string().nullable(),
  createdAt: z.string(),
  /** Which model produced this version, when AI was involved. */
  model: z.string().nullable(),
  taskRole: z.string().nullable(),
});
export type ProjectVersion = z.infer<typeof ProjectVersionSchema>;

export const VersionDiffEntrySchema = z.object({
  path: z.string(),
  change: z.enum(['added', 'modified', 'deleted']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type VersionDiffEntry = z.infer<typeof VersionDiffEntrySchema>;

export const VersionDiffSchema = z.object({
  fromVersionId: z.string().nullable(),
  toVersionId: z.string(),
  entries: z.array(VersionDiffEntrySchema),
});
export type VersionDiff = z.infer<typeof VersionDiffSchema>;
