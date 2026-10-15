import type { Integration } from '@wolf-forge/shared-types';
import { ApiError } from '../services/errors.js';
import type { GitHubIntegrationService } from './github.js';
import { GitHubApi } from './github-api.js';
import type { OAuthStateService } from './oauth-state.js';

/**
 * GitHub OAuth App flow (server side).
 *
 * Security posture:
 *  - `state` is a random high-entropy token bound server-side to the user and
 *    the return path; it is consumed exactly once and expires.
 *  - The code is exchanged for a token server-side and the token is verified
 *    by calling the GitHub API before it is ever persisted.
 *  - The token is encrypted at rest by GitHubIntegrationService and is never
 *    returned to the browser.
 */
export class GitHubOAuthService {
  constructor(
    private readonly github: GitHubIntegrationService,
    private readonly oauthState: OAuthStateService,
    private readonly config: { clientId: string; clientSecret: string; callbackUrl: string },
  ) {}

  oauthConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  async buildAuthorizeUrl(uid: string, returnTo: string): Promise<string> {
    if (!this.oauthConfigured()) {
      throw ApiError.notConfigured(
        'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or connect by pasting a personal access token.',
        { setup: 'set-up-github-oauth' },
      );
    }
    const state = await this.oauthState.begin(uid, 'github', returnTo);
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      scope: 'repo',
      state,
      // `user` identity is needed to resolve the connected account's login.
      allow_signup: 'false',
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchanges an OAuth code for a token, verifies it, and persists it for the
   * user bound to the consumed state. Returns the stored integration plus the
   * return path recorded when the flow began.
   */
  async handleCallback(
    state: string,
    code: string,
  ): Promise<{ integration: Integration; returnTo: string; uid: string }> {
    const record = await this.oauthState.consume(state, 'github');
    if (!record) {
      throw ApiError.unauthorized(
        'Invalid or expired OAuth state. Close this tab and start the connection again.',
      );
    }
    const token = await this.exchangeCode(code);
    // Verify before persisting — a connection is only claimed once the token
    // actually authenticates.
    const api = new GitHubApi(token);
    const user = await api
      .getUser()
      .catch(() => {
        throw ApiError.integrationError(
          'GitHub accepted the OAuth code but the resulting token could not authenticate. Try again.',
        );
      });
    const integration = await this.github.storeToken(record.uid, token, {
      account: user.login,
      scopes: ['repo', 'user:email'],
    });
    return { integration, returnTo: record.returnTo, uid: record.uid };
  }

  private async exchangeCode(code: string): Promise<string> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.callbackUrl,
      }),
    });
    if (!res.ok) {
      throw ApiError.integrationError(
        `GitHub OAuth token endpoint returned HTTP ${res.status}.`,
      );
    }
    const body = (await res.json().catch(() => null)) as
      | { access_token?: string; error?: string; error_description?: string }
      | null;
    if (!body?.access_token) {
      throw ApiError.integrationError(
        `GitHub OAuth failed: ${body?.error_description ?? body?.error ?? 'no access token returned'}`,
      );
    }
    return body.access_token;
  }
}