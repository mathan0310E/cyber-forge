import { z } from 'zod';

export const IntegrationProvider = z.enum(['github', 'vercel']);
export type IntegrationProvider = z.infer<typeof IntegrationProvider>;

export const IntegrationStatus = z.enum(['connected', 'disconnected', 'error', 'expired']);
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

export const IntegrationSchema = z.object({
  provider: IntegrationProvider,
  status: IntegrationStatus,
  /** Provider-side account label, e.g. the GitHub login. Never a token. */
  accountLabel: z.string().nullable(),
  scopes: z.array(z.string()),
  /** True when the server holds usable credentials for this provider. */
  configured: z.boolean(),
  /** Honest, actionable description of what the user must do next. */
  setupHint: z.string(),
  connectedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /**
   * True when the user explicitly skipped connecting this provider during the
   * post-sign-in onboarding flow. Skipping persists; the user can still
   * connect later from Integrations.
   */
  skipped: z.boolean().default(false),
  /**
   * OAuth capability signal. When false, the "connect" button falls back to
   * the manual token path (or an honest setup-required state) instead of
   * launching an OAuth dance that cannot succeed.
   */
  oauthAvailable: z.boolean().default(false),
});
export type Integration = z.infer<typeof IntegrationSchema>;

/** Response body for POST /integrations/:provider/authorize. */
export const OAuthAuthorizeResponseSchema = z.object({
  /** Absolute URL the browser should navigate to (provider consent page). */
  authorizeUrl: z.string().url(),
  provider: IntegrationProvider,
});
export type OAuthAuthorizeResponse = z.infer<typeof OAuthAuthorizeResponseSchema>;

/** Response body for POST /integrations/:provider/skip. */
export const IntegrationSkipResponseSchema = z.object({
  provider: IntegrationProvider,
  skipped: z.literal(true),
});
export type IntegrationSkipResponse = z.infer<typeof IntegrationSkipResponseSchema>;

export const GitHubConnectRequestSchema = z.object({
  /** Personal access token path, for users who prefer not to run an OAuth app. */
  token: z.string().min(20).max(255).optional(),
});
export type GitHubConnectRequest = z.infer<typeof GitHubConnectRequestSchema>;

export const GitHubRepositorySchema = z.object({
  id: z.number(),
  fullName: z.string(),
  name: z.string(),
  owner: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  htmlUrl: z.string(),
  updatedAt: z.string(),
});
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;

export const CreateRepositoryRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore'),
  description: z.string().trim().max(350).default(''),
  private: z.boolean().default(true),
});
export type CreateRepositoryRequest = z.infer<typeof CreateRepositoryRequestSchema>;

export const PushToGitHubRequestSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'Use owner/repo'),
  branch: z.string().trim().min(1).max(200).default('main'),
  commitMessage: z.string().trim().min(1).max(200),
  /** Optional: create the repository first if it does not exist. */
  createIfMissing: z.boolean().default(false),
  private: z.boolean().default(true),
});
export type PushToGitHubRequest = z.infer<typeof PushToGitHubRequestSchema>;

export const PushResultSchema = z.object({
  repository: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  commitUrl: z.string(),
  filesPushed: z.number().int().nonnegative(),
});
export type PushResult = z.infer<typeof PushResultSchema>;

export const DeploymentStatus = z.enum([
  'queued',
  'building',
  'ready',
  'error',
  'cancelled',
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export const DeploymentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  ownerUid: z.string(),
  provider: z.string(),
  status: DeploymentStatus,
  versionId: z.string().nullable(),
  providerDeploymentId: z.string().nullable(),
  /** Only ever set from a provider-confirmed `ready` payload. */
  liveUrl: z.string().nullable(),
  errorSummary: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

export const CreateDeploymentRequestSchema = z.object({
  versionId: z.string().optional(),
  /** Provider-specific target hint; validated server-side. */
  target: z.enum(['preview', 'production']).default('preview'),
});
export type CreateDeploymentRequest = z.infer<typeof CreateDeploymentRequestSchema>;
