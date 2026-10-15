import { describe, expect, it } from 'vitest';
import { applyBuiltinRefinement } from './pipeline.js';
import { generateFromTemplate } from '../ai/generator/builtin-generator.js';
import { WebsiteSpecSchema } from '@wolf-forge/shared-types';

function makeSpec() {
  return WebsiteSpecSchema.parse({
    title: 'Test site',
    description: 'A test site for refinement unit tests.',
    audience: 'Testers',
    pages: [
      {
        name: 'Home',
        route: '/',
        purpose: 'Present the site and primary call to action.',
        sections: ['hero'],
      },
    ],
    design: {},
  });
}

describe('applyBuiltinRefinement (deterministic no-provider refine)', () => {
  it('switches the theme to light when asked', () => {
    const spec = makeSpec();
    const changes = applyBuiltinRefinement(spec, 'Switch the whole site to light theme please');
    expect(changes).toContain('switched theme to light');
    expect(spec.design.background).toBe('#fbfaf7');
    expect(spec.design.text).toBe('#16181d');
  });

  it('switches back to dark', () => {
    const spec = makeSpec();
    applyBuiltinRefinement(spec, 'make it dark theme');
    expect(spec.theme).toBe('dark');
    expect(spec.design.background).toBe('#0b0d12');
  });

  it('applies a lime accent', () => {
    const spec = makeSpec();
    const changes = applyBuiltinRefinement(spec, 'Make the primary accent color lime');
    expect(changes).toContain('changed the primary accent to lime');
    expect(spec.design.primary).toBe('#d7f542');
  });

  it('applies an orange accent for buttons', () => {
    const spec = makeSpec();
    const changes = applyBuiltinRefinement(spec, 'change the buttons to orange');
    expect(changes).toContain('changed the primary accent to orange');
    expect(spec.design.primary).toBe('#ff8a24');
  });

  it('does not treat a bare color word as an accent change', () => {
    const spec = makeSpec();
    const changes = applyBuiltinRefinement(spec, 'I like the color blue generally');
    expect(changes).not.toContain('changed the primary accent to blue');
    expect(spec.design.primary).not.toBe('#60a5fa');
  });

  it('marks the navigation sticky', () => {
    const spec = makeSpec();
    const changes = applyBuiltinRefinement(spec, 'Make the navigation sticky so it stays on top');
    expect(changes).toContain('made the navigation sticky');
    expect(spec.interactions).toContain('sticky navigation header');
  });

  it('returns no changes for unsupported instructions', () => {
    const spec = makeSpec();
    const changes = applyBuiltinRefinement(spec, 'Add a dark-mode toggle with a database backend');
    expect(changes).toHaveLength(0);
    // Unsupported keyword should not mutate the design.
    expect(spec.design.primary).toBe('#19d3f3');
  });

  it('supports combined edits in one instruction', () => {
    const spec = makeSpec();
    const changes = applyBuiltinRefinement(spec, 'Make it light theme with a lime accent and sticky nav');
    expect(changes).toEqual(
      expect.arrayContaining([
        'switched theme to light',
        'changed the primary accent to lime',
        'made the navigation sticky',
      ]),
    );
  });

  it('emits sticky navigation CSS into the generated theme.css', () => {
    const spec = makeSpec();
    applyBuiltinRefinement(spec, 'Make the navigation sticky');
    const gen = generateFromTemplate({ spec, category: 'landing' });
    const themeCss = gen.files.find((f) => f.path === 'src/styles/theme.css')?.content ?? '';
    expect(themeCss).toContain('position: sticky');
    expect(themeCss).toContain('top: 0');
  });
});