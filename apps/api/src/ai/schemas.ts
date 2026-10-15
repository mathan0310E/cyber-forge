import type { z } from 'zod';
import {
  BriefAnalysisSchema,
  GenerationResultSchema,
  PatchSchema,
  RepairResultSchema,
  ReviewResultSchema,
  WebsiteSpecSchema,
} from '@wolf-forge/shared-types';

/**
 * The structured-output Zod schemas used across the pipeline, exported from one
 * place so every stage imports a single symbol.
 */
export const scopedSchema = {
  analysis: BriefAnalysisSchema,
  spec: WebsiteSpecSchema,
  generation: GenerationResultSchema,
  patch: PatchSchema,
  repair: RepairResultSchema,
  review: ReviewResultSchema,
} as const;

export type ScopedSchema = (typeof scopedSchema)[keyof typeof scopedSchema];
export type SpecSchemaValue = z.infer<typeof WebsiteSpecSchema>;