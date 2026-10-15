import type { Integration } from '@wolf-forge/shared-types';
import { api } from '../../lib/api';

export type Provider = 'github' | 'vercel';
const PROVIDERS: Provider[] = ['github', 'vercel'];

export async function fetchIntegrationStatuses(): Promise<Integration[]> {
  const r = await api.get<{ integrations: Integration[] }>('/integrations');
  return r.integrations;
}

/** Starts a provider OAuth flow and navigates to the provider consent page. */
export async function startOAuth(
  provider: Provider,
  returnTo = '/app/connect',
): Promise<void> {
  const r = await api.post<{ authorizeUrl: string }>(`/integrations/${provider}/authorize`, {
    returnTo,
  });
  // Full-page navigation: the provider's authorization page is cross-origin and
  // the callback URL is public (state-bound), so it must not be an iframe or
  // fetch — a real browser navigation keeps the session in this tab's storage
  // and returns here with ?connected=github|vercel.
  window.location.assign(r.authorizeUrl);
}

/** Persists the user's "skip this provider for now" choice. */
export async function skipProvider(provider: Provider): Promise<void> {
  await api.post(`/integrations/${provider}/skip`, { returnTo: '/app/connect' });
}

/**
 * The post-Google-sign-in onboarding sequence severity. Returns the integrations
 * that are not connected and not skipped, in a sensible order (GitHub first so
 * preview-mode editing works before deployment).
 */
export function pendingConnections(integrations: Integration[]): Provider[] {
  return PROVIDERS.filter((p) => {
    const i = integrations.find((x) => x.provider === p);
    if (!i) return true; // unlisted provider => treat as pending
    return i.status !== 'connected' && !i.skipped && i.oauthAvailable;
  });
}

/** True when the onboarding flow has nothing left to connect. */
export function onboardingComplete(integrations: Integration[]): boolean {
  return pendingConnections(integrations).length === 0;
}