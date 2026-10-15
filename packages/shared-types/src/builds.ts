import { z } from 'zod';

/**
 * Build job state machine. Every transition is validated server-side against
 * ALLOWED_TRANSITIONS; illegal transitions are rejected rather than stored.
 */
export const BUILD_STATES = [
  'Queued',
  'Analyzing',
  'Planning',
  'Generating',
  'Installing',
  'Building',
  'Repairing',
  'StartingPreview',
  'PreviewReady',
  'Deploying',
  'Deployed',
  'Failed',
  'Cancelled',
] as const;
export const BuildState = z.enum(BUILD_STATES);
export type BuildState = z.infer<typeof BuildState>;

export const TERMINAL_BUILD_STATES: readonly BuildState[] = [
  'PreviewReady',
  'Deployed',
  'Failed',
  'Cancelled',
];

export const ALLOWED_TRANSITIONS: Record<BuildState, readonly BuildState[]> = {
  Queued: ['Analyzing', 'Cancelled', 'Failed'],
  Analyzing: ['Planning', 'Failed', 'Cancelled'],
  Planning: ['Generating', 'Failed', 'Cancelled'],
  Generating: ['Installing', 'Failed', 'Cancelled'],
  Installing: ['Building', 'Failed', 'Cancelled'],
  Building: ['Repairing', 'StartingPreview', 'Failed', 'Cancelled'],
  Repairing: ['Installing', 'Building', 'StartingPreview', 'Failed', 'Cancelled'],
  StartingPreview: ['PreviewReady', 'Failed', 'Cancelled'],
  PreviewReady: ['Deploying', 'Cancelled'],
  Deploying: ['Deployed', 'Failed'],
  Deployed: [],
  Failed: ['Queued'],
  Cancelled: ['Queued'],
};

export function canTransition(from: BuildState, to: BuildState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: BuildState): boolean {
  return TERMINAL_BUILD_STATES.includes(state);
}

export const BuildOperation = z.enum(['generate', 'refine', 'rebuild', 'deploy']);
export type BuildOperation = z.infer<typeof BuildOperation>;

export const BUILD_EVENT_TYPES = [
  'state',
  'log',
  'progress',
  'file-written',
  'diagnostic',
  'model-selected',
  'preview-ready',
  'error',
  'usage',
] as const;
export const BuildEventType = z.enum(BUILD_EVENT_TYPES);
export type BuildEventType = z.infer<typeof BuildEventType>;

export const BuildEventSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  seq: z.number().int().nonnegative(),
  type: BuildEventType,
  state: BuildState,
  message: z.string(),
  /** Structured, already-redacted payload. Never contains secrets or full prompts. */
  data: z.record(z.unknown()).default({}),
  at: z.string(),
});
export type BuildEvent = z.infer<typeof BuildEventSchema>;

export const BuildJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  ownerUid: z.string(),
  operation: BuildOperation,
  state: BuildState,
  /** 0..1 progress derived from real stage completion, never a timer. */
  progress: z.number().min(0).max(1),
  instruction: z.string().nullable(),
  baseVersionId: z.string().nullable(),
  resultVersionId: z.string().nullable(),
  repairAttempts: z.number().int().nonnegative(),
  maxRepairAttempts: z.number().int().nonnegative(),
  errorSummary: z.string().nullable(),
  errorCode: z.string().nullable(),
  cancelRequested: z.boolean(),
  workerId: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Monotonic counter used by the SSE endpoint for resumption. */
  lastSeq: z.number().int().nonnegative(),
});
export type BuildJob = z.infer<typeof BuildJobSchema>;

export const CreateBuildRequestSchema = z
  .object({
    operation: BuildOperation.default('generate'),
    /** Required for `refine`; ignored otherwise. */
    instruction: z.string().trim().min(3).max(8000).optional(),
    baseVersionId: z.string().optional(),
    maxRepairAttempts: z.coerce.number().int().min(0).max(5).default(2),
  })
  .refine((v) => v.operation !== 'refine' || !!v.instruction, {
    message: 'A refinement instruction is required',
    path: ['instruction'],
  });
export type CreateBuildRequest = z.infer<typeof CreateBuildRequestSchema>;

export const BuildLogSchema = z.object({
  jobId: z.string(),
  /** Redacted, size-capped stdout/stderr from the sandbox. */
  text: z.string(),
  truncated: z.boolean(),
});
export type BuildLog = z.infer<typeof BuildLogSchema>;

export const BUILD_STATE_LABELS: Record<BuildState, string> = {
  Queued: 'Queued',
  Analyzing: 'Analyzing your request',
  Planning: 'Planning the site',
  Generating: 'Generating source files',
  Installing: 'Installing dependencies',
  Building: 'Building the project',
  Repairing: 'Repairing build errors',
  StartingPreview: 'Starting preview',
  PreviewReady: 'Preview ready',
  Deploying: 'Deploying',
  Deployed: 'Deployed',
  Failed: 'Failed',
  Cancelled: 'Cancelled',
};
