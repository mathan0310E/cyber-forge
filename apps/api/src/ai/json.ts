import { z } from 'zod';
import { ApiError } from '../services/errors.js';

/**
 * Extracts the first balanced JSON value from model output.
 *
 * Free models routinely wrap JSON in prose or fenced blocks, so this walks the
 * string tracking brace depth and string state rather than relying on a regex.
 */
export function extractJson(text: string): string | null {
  const fenced = /```(?:json|jsonc|JSON)?\s*([\s\S]*?)```/.exec(text);
  const haystacks = fenced ? [fenced[1]!, text] : [text];

  for (const haystack of haystacks) {
    const start = firstOpeningBracket(haystack);
    if (start === -1) continue;
    const candidate = sliceBalanced(haystack, start);
    if (candidate) return candidate;
  }
  return null;
}

function firstOpeningBracket(text: string): number {
  const obj = text.indexOf('{');
  const arr = text.indexOf('[');
  if (obj === -1) return arr;
  if (arr === -1) return obj;
  return Math.min(obj, arr);
}

function sliceBalanced(text: string, start: number): string | null {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Common, safe repairs for JSON that free models emit. */
function repairCommonIssues(raw: string): string {
  let out = raw;
  // Trailing commas before a closing brace/bracket.
  out = out.replace(/,(\s*[}\]])/g, '$1');
  // Smart quotes used as string delimiters.
  out = out.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // Line comments outside of strings (best effort).
  out = out.replace(/^\s*\/\/.*$/gm, '');
  return out;
}

export interface ParseOptions<T extends z.ZodTypeAny> {
  schema: T;
  /** Short description used in error messages, e.g. "website specification". */
  label: string;
}

/**
 * Parses model output into a validated value.
 *
 * Returns a discriminated result rather than throwing, so callers can decide to
 * re-ask the model with the validation error attached (bounded repair) instead
 * of failing the whole build.
 */
export function parseModelJson<T extends z.ZodTypeAny>(
  text: string,
  options: ParseOptions<T>,
):
  | { ok: true; value: z.infer<T> }
  | { ok: false; reason: string; issues: string[] } {
  const extracted = extractJson(text);
  if (!extracted) {
    return {
      ok: false,
      reason: `The model did not return JSON for the ${options.label}.`,
      issues: ['No JSON object or array was found in the response.'],
    };
  }

  const attempts = [extracted, repairCommonIssues(extracted)];
  let lastIssues: string[] = ['Unknown parse failure.'];

  for (const candidate of attempts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (e) {
      lastIssues = [e instanceof Error ? e.message : 'JSON.parse failed'];
      continue;
    }
    const result = options.schema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data };
    lastIssues = result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
  }

  return {
    ok: false,
    reason: `The model's ${options.label} did not match the required schema.`,
    issues: lastIssues.slice(0, 12),
  };
}

export function requireModelJson<T extends z.ZodTypeAny>(
  text: string,
  options: ParseOptions<T>,
): z.infer<T> {
  const result = parseModelJson(text, options);
  if (!result.ok) {
    throw ApiError.internal(`Invalid ${options.label} from the model`, {
      reason: result.reason,
      issues: result.issues,
    });
  }
  return result.value;
}
