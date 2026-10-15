import { ApiError } from '../services/errors.js';

/**
 * Dependency allowlist.
 *
 * Generated projects run `npm install`, and install scripts are arbitrary code.
 * Rather than trying to sanitise an unbounded set of packages, Wolf Forge only
 * permits a curated, pinned set of well-known packages. A model that asks for
 * anything else gets an actionable error instead of an install.
 *
 * This is the primary supply-chain control for generated projects.
 */
export const ALLOWED_DEPENDENCIES: Record<string, string> = {
  react: '^18.3.1',
  'react-dom': '^18.3.1',
  'react-router-dom': '^6.28.0',
  'lucide-react': '^0.469.0',
  'framer-motion': '^11.15.0',
  clsx: '^2.1.1',
  'tailwind-merge': '^2.6.0',
  zod: '^3.24.1',
  'date-fns': '^4.1.0',
  recharts: '^2.15.0',
  '@tanstack/react-query': '^5.62.7',
};

export const ALLOWED_DEV_DEPENDENCIES: Record<string, string> = {
  typescript: '^5.7.3',
  vite: '^5.4.11',
  '@vitejs/plugin-react': '^4.3.4',
  '@types/react': '^18.3.18',
  '@types/react-dom': '^18.3.5',
  tailwindcss: '^3.4.17',
  postcss: '^8.4.49',
  autoprefixer: '^10.4.20',
  '@types/node': '^22.10.5',
};

const ALL_ALLOWED = { ...ALLOWED_DEPENDENCIES, ...ALLOWED_DEV_DEPENDENCIES };

/** Packages that must never be installed, even if a name somehow slips through. */
const DENIED_PATTERNS: RegExp[] = [
  /^@?[^/]*postinstall/i,
  /^(node-gyp|node-pre-gyp)$/i,
  /^npm$/i,
  /^(pre|post)?install$/i,
  /^.*-(bin|cli)$/i,
];

export interface DependencyCheckResult {
  accepted: Record<string, string>;
  rejected: Array<{ name: string; reason: string }>;
}

export function checkDependencies(names: readonly string[]): DependencyCheckResult {
  const accepted: Record<string, string> = {};
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    if (name.length > 120) {
      rejected.push({ name: name.slice(0, 40), reason: 'Package name is too long.' });
      continue;
    }
    // Reject anything that is not a bare package name: no versions, paths, or URLs.
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      rejected.push({
        name,
        reason: 'Only bare package names are accepted; versions, paths, URLs and git refs are not.',
      });
      continue;
    }
    if (DENIED_PATTERNS.some((re) => re.test(name))) {
      rejected.push({ name, reason: 'This package is on the deny list.' });
      continue;
    }
    const pinned = ALL_ALLOWED[name];
    if (!pinned) {
      rejected.push({
        name,
        reason:
          'Not on the approved dependency list. Wolf Forge installs only vetted packages so that ' +
          'generated projects cannot run arbitrary install scripts.',
      });
      continue;
    }
    accepted[name] = pinned;
  }

  return { accepted, rejected };
}

export function assertDependenciesAllowed(names: readonly string[]): Record<string, string> {
  const { accepted, rejected } = checkDependencies(names);
  if (rejected.length > 0) {
    throw ApiError.badRequest(
      `Rejected ${rejected.length} dependency request(s): ` +
        rejected.map((r) => `${r.name} (${r.reason})`).join('; '),
      { rejected },
    );
  }
  return accepted;
}

/**
 * Validates the package.json of a generated project against the allowlist and
 * rewrites dependency versions to the pinned, approved ranges.
 */
export function sanitizePackageJson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw ApiError.badRequest(
      `Generated package.json is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw ApiError.badRequest('Generated package.json must be a JSON object.');
  }

  const pkg = parsed as Record<string, unknown>;
  const deps = pkg.dependencies;
  const devDeps = pkg.devDependencies;

  const checkSection = (section: unknown, label: string): Record<string, string> => {
    if (section === undefined) return {};
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw ApiError.badRequest(`package.json ${label} must be an object.`);
    }
    return assertDependenciesAllowed(Object.keys(section as Record<string, unknown>));
  };

  const safeDeps = checkSection(deps, 'dependencies');
  const safeDevDeps = checkSection(devDeps, 'devDependencies');

  const sanitized: Record<string, unknown> = {
    name: sanitizePackageName(pkg.name),
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: sanitizeScripts(pkg.scripts),
  };
  if (Object.keys(safeDeps).length > 0) sanitized.dependencies = sortKeys(safeDeps);
  if (Object.keys(safeDevDeps).length > 0) sanitized.devDependencies = sortKeys(safeDevDeps);

  return `${JSON.stringify(sanitized, null, 2)}\n`;
}

function sanitizePackageName(value: unknown): string {
  if (typeof value !== 'string') return 'wolf-forge-site';
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'wolf-forge-site';
}

/** Only build/serve scripts survive, and only with known-safe commands. */
function sanitizeScripts(value: unknown): Record<string, string> {
  const allowed = new Set(['dev', 'build', 'preview', 'start', 'lint', 'typecheck']);
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key) || typeof raw !== 'string') continue;
    const command = raw.trim();
    if (command.length === 0 || command.length > 300) continue;
    // `&&` chaining is allowed (e.g. `tsc -b && vite build`). A bare `&`
    // (backgrounding) or any other shell metacharacter that could chain or
    // interpolate is rejected.
    if (/(^|[^&])&([^&]|$)/.test(command)) continue;
    if (/[;|`$(){}<>\n]/.test(command)) continue;
    out[key] = command;
  }
  return out;
}

function sortKeys(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
