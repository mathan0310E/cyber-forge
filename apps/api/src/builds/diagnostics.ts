import { redact } from '../services/redact.js';

export interface BuildDiagnostic {
  severity: 'error' | 'warning';
  file: string | null;
  line: number | null;
  column: number | null;
  code: string | null;
  message: string;
}

/**
 * Extracts structured diagnostics from raw build output.
 *
 * Handles the shapes produced by `tsc`, `vite` and npm. Diagnostics feed the
 * repair prompt directly, so parsing accuracy determines whether a repair
 * attempt has a chance of succeeding.
 */

// tsc: `src/App.tsx(12,5): error TS2322: Type 'x' is not assignable to type 'y'.`
const TSC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;

// vite / esbuild: `src/App.tsx:12:5: ERROR: message` or `[vite] error ...`
const VITE_RE = /^(.+?):(\d+):(\d+):\s*(ERROR|error|WARNING|warning):\s*(.+)$/gm;

// Rollup-style: `[vite]: Rollup failed to resolve import "x" from "src/App.tsx".`
const ROLLUP_RESOLVE_RE = /Rollup failed to resolve import "([^"]+)" from "([^"]+)"/g;

// Missing module: `Cannot find module './Foo' or its corresponding type declarations.`
const MISSING_MODULE_RE = /Cannot find module '([^']+)'/g;

// npm: `npm ERR! 404 Not Found - GET https://registry.npmjs.org/foo`
const NPM_404_RE = /404 Not Found\s*-\s*GET\s+\S+\/([^\s/]+)/g;

export function parseDiagnostics(rawOutput: string, limit = 40): BuildDiagnostic[] {
  const output = redact(rawOutput, 120_000);
  const found: BuildDiagnostic[] = [];

  for (const m of output.matchAll(TSC_RE)) {
    found.push({
      severity: m[4] === 'error' ? 'error' : 'warning',
      file: normalizeFile(m[1]!),
      line: Number.parseInt(m[2]!, 10),
      column: Number.parseInt(m[3]!, 10),
      code: m[5]!,
      message: m[6]!.trim(),
    });
  }

  for (const m of output.matchAll(VITE_RE)) {
    found.push({
      severity: /error/i.test(m[4]!) ? 'error' : 'warning',
      file: normalizeFile(m[1]!),
      line: Number.parseInt(m[2]!, 10),
      column: Number.parseInt(m[3]!, 10),
      code: null,
      message: m[5]!.trim(),
    });
  }

  for (const m of output.matchAll(ROLLUP_RESOLVE_RE)) {
    found.push({
      severity: 'error',
      file: normalizeFile(m[2]!),
      line: null,
      column: null,
      code: 'ROLLUP_RESOLVE',
      message: `Could not resolve import "${m[1]}". The file does not exist or the dependency is not installed.`,
    });
  }

  for (const m of output.matchAll(MISSING_MODULE_RE)) {
    found.push({
      severity: 'error',
      file: null,
      line: null,
      column: null,
      code: 'MISSING_MODULE',
      message: `Cannot find module '${m[1]}'.`,
    });
  }

  for (const m of output.matchAll(NPM_404_RE)) {
    found.push({
      severity: 'error',
      file: null,
      line: null,
      column: null,
      code: 'NPM_404',
      message: `Package "${m[1]}" was not found in the npm registry. Remove it or use an approved package.`,
    });
  }

  // npm-level failures that do not match the patterns above.
  if (found.length === 0 && /npm ERR!/i.test(output)) {
    const firstErr = /npm ERR!\s*(.+)/.exec(output);
    found.push({
      severity: 'error',
      file: null,
      line: null,
      column: null,
      code: 'NPM_ERROR',
      message: firstErr ? firstErr[1]!.trim().slice(0, 300) : 'npm reported an error.',
    });
  }

  // De-duplicate identical diagnostics while preserving order.
  const seen = new Set<string>();
  const unique: BuildDiagnostic[] = [];
  for (const d of found) {
    const key = `${d.file}|${d.line}|${d.code}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
    if (unique.length >= limit) break;
  }
  return unique;
}

function normalizeFile(raw: string): string {
  const trimmed = raw.trim().replace(/^\.\//, '');
  // Vite prints absolute container paths; keep only the project-relative part.
  const workspaceIdx = trimmed.lastIndexOf('/workspace/');
  if (workspaceIdx >= 0) return trimmed.slice(workspaceIdx + '/workspace/'.length);
  return trimmed;
}

/**
 * Extracts the source files most likely responsible for a failure, so the
 * repair prompt can stay small and focused.
 */
export function filesImplicatedByDiagnostics(
  diagnostics: BuildDiagnostic[],
  available: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const d of diagnostics) {
    if (d.file && available.has(d.file)) out.add(d.file);
  }
  return [...out];
}

export function formatDiagnosticsForPrompt(diagnostics: BuildDiagnostic[]): string[] {
  return diagnostics.map((d) => {
    const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : '(project)';
    const code = d.code ? ` [${d.code}]` : '';
    return `${d.severity.toUpperCase()} ${where}${code}: ${d.message}`;
  });
}

/**
 * A build is only considered successful when the command exited zero AND the
 * expected output artefact exists. Vite can exit 0 while emitting nothing.
 */
export function buildSucceeded(
  exitCode: number,
  diagnostics: BuildDiagnostic[],
  outputExists: boolean,
): boolean {
  if (exitCode !== 0) return false;
  if (!outputExists) return false;
  return !diagnostics.some((d) => d.severity === 'error');
}
