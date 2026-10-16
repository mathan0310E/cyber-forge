import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDocStore } from '../db/local-store.js';
import { GitHubIntegrationService } from './github.js';
import { GitHubOAuthService } from './github-oauth.js';
import { OAuthStateService } from './oauth-state.js';
import { ApiError } from '../services/errors.js';

function makeServices(dir: string) {
  const db = new LocalDocStore(dir);
  const github = new GitHubIntegrationService(db, {
    clientId: 'Iv1.test-client',
    clientSecret: 'test-secret-abcdef',
    callbackUrl: 'http://localhost:3001/api/v1/integrations/github/callback',
    encryptionKey: 'abcdefghijklmnopqrstuvwxyz123456', // >=32 chars, not used for AES rounds here
  });
  const oauthState = new OAuthStateService(db);
  const oauth = new GitHubOAuthService(github, oauthState, {
    clientId: 'Iv1.test-client',
    clientSecret: 'test-secret-abcdef',
    callbackUrl: 'http://localhost:3001/api/v1/integrations/github/callback',
  });
  return { db, github, oauthState, oauth };
}

describe('GitHubOAuthService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-github-oauth-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('builds an authorize URL with a state bound to the uid and a safe return path', async () => {
    const { oauth, oauthState } = makeServices(dir);
    const url = await oauth.buildAuthorizeUrl('user_1', '/app/connect');
    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('Iv1.test-client');
    expect(parsed.searchParams.get('scope')).toBe('repo');
    const state = parsed.searchParams.get('state');
    expect(state).toBeTruthy();
    // The state token is the random one; it must be resolvable server-side.
    const record = await oauthState.consume(state!, 'github');
    expect(record?.uid).toBe('user_1');
  });

  it('rejects unconfigured OAuth with a helpful message', async () => {
    const db = new LocalDocStore(dir);
    const github = new GitHubIntegrationService(db, {
      clientId: '',
      clientSecret: '',
      callbackUrl: '',
      encryptionKey: 'x'.repeat(32),
    });
    const oauth = new GitHubOAuthService(github, new OAuthStateService(db), {
      clientId: '',
      clientSecret: '',
      callbackUrl: '',
    });
    await expect(oauth.buildAuthorizeUrl('u1', '/app/connect')).rejects.toThrow(ApiError);
  });

  it('saves the token only after verification and forbids a second use of the state', async () => {
    const { github, oauthState, oauth } = makeServices(dir);
    const state = await oauthState.begin('user_1', 'github', '/app/connect');

    // Verify call: exchange => a token, /user => login.
    const exchangeFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/login/oauth/access_token')) {
          return new Response(
            JSON.stringify({ access_token: 'gho_token_123', token_type: 'bearer' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/user')) {
          return new Response(JSON.stringify({ login: 'octocat' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      });

    const { integration, returnTo, uid } = await oauth.handleCallback(state, 'auth_code');
    expect(uid).toBe('user_1');
    expect(returnTo).toBe('/app/connect');
    expect(integration.status).toBe('connected');
    expect(integration.accountLabel).toBe('octocat');

    // The state is consumed: a second callback with the same state is rejected.
    exchangeFetch.mockClear();
    await expect(oauth.handleCallback(state, 'auth_code')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    exchangeFetch.mockRestore();

    const status = await github.statusFor('user_1');
    expect(status.status).toBe('connected');
  });

  it('throws a clear error when the token endpoint rejects', async () => {
    const { oauthState, oauth } = makeServices(dir);
    const state = await oauthState.begin('user_1', 'github', '/app/connect');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'bad_verification_code' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(oauth.handleCallback(state, 'bad_code')).rejects.toThrow(/GitHub OAuth failed/);
    vi.restoreAllMocks();
  });

  it('persists a skip so onboarding stops asking, without marking connected', async () => {
    const { github } = makeServices(dir);
    await github.setSkipped('user_1', true);
    const status = await github.statusFor('user_1');
    expect(status.skipped).toBe(true);
    expect(status.status).toBe('disconnected');
    expect(status.connectedAt).toBeNull();

    // Connecting afterwards clears the flag report: status is connected.
    const { oauthState, oauth } = makeServices(dir);
    const state = await oauthState.begin('user_1', 'github', '/app/connect');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'gho_skipped_then_connected' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ login: 'octocat' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const { integration } = await oauth.handleCallback(state, 'code');
    expect(integration.status).toBe('connected');
    vi.restoreAllMocks();
  });
});

