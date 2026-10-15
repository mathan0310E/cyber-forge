import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DocStore } from '../db/store.js';
import { LocalDocStore } from '../db/local-store.js';
import { OAuthStateService } from './oauth-state.js';

describe('OAuthStateService', () => {
  let dir: string;
  let db: DocStore;
  let svc: OAuthStateService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-oauth-state-'));
    db = new LocalDocStore(dir);
    await db.init();
    svc = new OAuthStateService(db);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('consumes a valid state exactly once', async () => {
    const state = await svc.begin('user_1', 'github', '/app/connect');
    const first = await svc.consume(state, 'github');
    expect(first).not.toBeNull();
    expect(first?.uid).toBe('user_1');
    expect(first?.returnTo).toBe('/app/connect');

    const second = await svc.consume(state, 'github');
    expect(second).toBeNull();
  });

  it('rejects an unknown state', async () => {
    expect(await svc.consume('a'.repeat(48), 'github')).toBeNull();
  });

  it('rejects state for the wrong provider', async () => {
    const state = await svc.begin('user_1', 'github', '/app/connect');
    expect(await svc.consume(state, 'vercel')).toBeNull();
    // Consuming with the wrong provider deletes the record, so the real
    // provider cannot use it afterwards either.
    expect(await svc.consume(state, 'github')).toBeNull();
  });

  it('rejects malformed state strings without touching the store', async () => {
    expect(await svc.consume('', 'github')).toBeNull();
    expect(await svc.consume('../etc/passwd', 'github')).toBeNull();
    expect(await svc.consume('x'.repeat(10), 'github')).toBeNull();
  });
});