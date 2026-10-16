import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Integration } from '@wolf-forge/shared-types';
import { useAuth } from '../auth/AuthContext';
import { WolfMark } from '../../components/PublicLayout';
import {
  type Provider,
  fetchIntegrationStatuses,
  onboardingComplete,
  pendingConnections,
  skipProvider,
  startOAuth,
} from './lib';

type ProviderPhase = 'checking' | 'connecting' | 'connected' | 'skipped' | 'failed';

interface ProviderCell {
  provider: Provider;
  integration: Integration | null;
  phase: ProviderPhase;
  error: string | null;
}

const ORDER: Provider[] = ['github', 'vercel'];
const LABELS: Record<Provider, { name: string; blurb: string }> = {
  github: {
    name: 'GitHub',
    blurb: 'Push generated projects to a repository under your account.',
  },
  vercel: {
    name: 'Vercel',
    blurb: 'Deploy your previews and exports to a live URL.',
  },
};

function fetchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/**
 * Post-sign-in integration onboarding.
 *
 * When a user signs in (especially with Google), the app automatically checks
 * GitHub and Vercel connections. Disconnected providers that support OAuth are
 * auto-attempted one after another: each opens the provider's authorization
 * page with a state-bound, one-time token, and the provider redirects back to
 * `/app/connect?connected=<provider>`. Providers that were skipped or are
 * already connected are left alone; every provider can be skipped or retried at
 * any time. When nothing is left pending, the user is sent to the dashboard.
 */
export function ConnectIntegrationsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [cells, setCells] = useState<ProviderCell[]>(() =>
    ORDER.map((provider) => ({
      provider,
      integration: null,
      phase: 'checking',
      error: null,
    })),
  );
  const [overallError, setOverallError] = useState<string | null>(null);
  const started = useRef(false);

  const upsert = useCallback((integration: Integration) => {
    setCells((prev) =>
      prev.map((c) => (c.provider === integration.provider ? { ...c, integration } : c)),
    );
  }, []);

  const refresh = useCallback(async () => {
    const list = await fetchIntegrationStatuses();
    list.forEach(upsert);
    return list;
  }, [upsert]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const run = async () => {
      try {
        const list = await refresh();
        if (cancelled) return;
        const pending = pendingConnections(list);
        if (pending.length === 0) {
          setOverallError(null);
          window.setTimeout(() => navigate('/app', { replace: true }), 800);
          return;
        }
        // If we came back from a provider callback we can clear the query.
        if (window.location.search.includes('connected=')) {
          const params = fetchParams();
          params.delete('connected');
          const qs = params.toString();
          const target = qs ? `?${qs}` : window.location.pathname;
          window.history.replaceState({}, '', target);
        }
        // Auto-start the first pending provider once.
        if (!started.current) {
          started.current = true;
          await autoStart(pending[0] as Provider, list);
        }
      } catch (e) {
        if (!cancelled) {
          setOverallError(e instanceof Error ? e.message : 'Could not check integration status.');
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [user, navigate, refresh, autoStart]);

  const autoStart = useCallback(
    async (provider: Provider, list?: Integration[]) => {
      // Guard: only auto-start providers that can actually run OAuth.
      const data = list ?? (await refresh());
      const integ = data.find((x) => x.provider === provider);
      if (integ && (integ.status === 'connected' || integ.skipped || !integ.oauthAvailable)) {
        return;
      }
      setCells((prev) =>
        prev.map((c) => (c.provider === provider ? { ...c, phase: 'connecting', error: null } : c)),
      );
      try {
        await startOAuth(provider, '/app/connect');
        // startOAuth navigates away; if it returns, the provider was reachable but
        // something prevented navigation — treat as failed to avoid an infinite loop.
        throw new Error('The provider authorization window did not open.');
      } catch (e) {
        setCells((prev) =>
          prev.map((c) =>
            c.provider === provider
              ? {
                  ...c,
                  phase: 'failed',
                  error: e instanceof Error ? e.message : 'Connection failed. Retry or skip.',
                }
              : c,
          ),
        );
      }
    },
    [refresh],
  );

  // Re-check when returning from a provider callback (?connected=github|vercel).
  useEffect(() => {
    if (!user) return;
    const params = fetchParams();
    const justConnected = params.get('connected');
    if (!justConnected) return;
    started.current = false;
    const recheck = async () => {
      await refresh();
      const list = await fetchIntegrationStatuses();
      setCells(ORDER.map((p) => {
        const i = list.find((x) => x.provider === p) ?? null;
        return {
          provider: p,
          integration: i,
          phase: i?.status === 'connected' ? 'connected' : 'checking',
          error: null,
        };
      }));
    };
    void recheck();
  }, [user, refresh]);

  const overall = useMemo(() => {
    const matrix: Integration[] = cells
      .map((c) => c.integration)
      .filter((x): x is Integration => x !== null);
    return onboardingComplete(matrix);
  }, [cells]);

  // When nothing is left to do (all connected or skipped), go to the dashboard.
  useEffect(() => {
    if (!user) return;
    if (overall && !window.location.search.includes('connected=')) {
      const t = window.setTimeout(() => navigate('/app', { replace: true }), 600);
      return () => window.clearTimeout(t);
    }
  }, [overall, user, navigate]);

  const onSkip = useCallback(
    async (provider: Provider) => {
      try {
        await skipProvider(provider);
        setCells((prev) =>
          prev.map((c) => (c.provider === provider ? { ...c, phase: 'skipped' } : c)),
        );
      } catch (e) {
        setOverallError(e instanceof Error ? e.message : 'Could not skip this provider.');
      }
    },
    [],
  );

  const onConnect = useCallback(
    async (provider: Provider) => {
      await autoStart(provider);
    },
    [autoStart],
  );

  const onFinish = useCallback(() => {
    navigate('/app', { replace: true });
  }, [navigate]);

  return (
    <div className="min-h-screen bg-forge-bg px-4 py-10">
      <div className="mx-auto max-w-xl">
        <div className="flex items-center justify-center gap-2">
          <WolfMark className="h-10 w-10" />
          <span className="font-display text-2xl font-bold">
            Wolf <span className="text-forge-orange">Forge</span>
          </span>
        </div>
        <h1 className="mt-6 text-center font-display text-3xl font-bold">
          Link your builder
        </h1>
        <p className="mt-2 text-center text-forge-muted">
          Connecting GitHub and Vercel lets you push code and deploy live. You can skip either and
          connect it later from Integrations.
        </p>

        {overallError && (
          <div className="mt-4 rounded-lg border border-forge-orange/40 bg-forge-orange/10 px-4 py-3 text-sm text-forge-orange" role="alert">
            {overallError}
          </div>
        )}

        <div className="mt-6 space-y-3">
          {cells.map((c) => {
            const label = LABELS[c.provider];
            const connected = c.phase === 'connected' || c.integration?.status === 'connected';
            return (
              <div
                key={c.provider}
                className="rounded-2xl border border-forge-border bg-forge-panel p-5"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-display text-lg font-semibold">{label.name}</span>
                      <PhaseChip phase={connected ? 'connected' : c.phase === 'failed' ? 'checking' : c.phase} />
                    </div>
                    <p className="mt-1 text-sm text-forge-muted">{label.blurb}</p>
                    {c.integration?.accountLabel && (
                      <p className="mt-1 text-xs text-forge-cyan">@{c.integration.accountLabel}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {c.phase === 'failed' && (
                      <>
                        <button
                          type="button"
                          onClick={() => void onConnect(c.provider)}
                          className="rounded-lg bg-forge-cyan px-3 py-1.5 text-sm font-semibold text-forge-bg hover:brightness-95"
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() => void onSkip(c.provider)}
                          className="rounded-lg border border-forge-border px-3 py-1.5 text-sm text-forge-muted hover:text-forge-text"
                        >
                          Skip
                        </button>
                      </>
                    )}
                    {c.phase === 'checking' && (
                      <span className="px-3 py-1.5 text-sm text-forge-muted">
                        {c.integration ? '' : 'Loading…'}
                      </span>
                    )}
                    {connected && (
                      <button
                        type="button"
                        onClick={onFinish}
                        className="rounded-lg bg-forge-lime px-3 py-1.5 text-sm font-semibold text-forge-bg hover:brightness-95"
                      >
                        Done
                      </button>
                    )}
                  </div>
                </div>
                {c.phase === 'failed' && c.error && (
                  <p className="mt-2 text-sm text-forge-orange" role="alert">
                    {c.error}
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  {c.phase !== 'connecting' && c.phase !== 'checking' && !connected && (
                    <button
                      type="button"
                      onClick={() => void onConnect(c.provider)}
                      className="text-sm font-medium text-forge-cyan hover:underline"
                    >
                      Connect now
                    </button>
                  )}
                  {c.phase === 'connecting' && (
                    <span className="text-sm text-forge-muted">Waiting for authorization…</span>
                  )}
                  {!connected && c.phase !== 'connecting' && (
                    <button
                      type="button"
                      onClick={() => void onSkip(c.provider)}
                      className="text-sm font-medium text-forge-muted hover:underline"
                    >
                      Skip for now
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {overall && (
            <button
              type="button"
              onClick={onFinish}
              className="mt-2 w-full rounded-lg bg-forge-lime px-4 py-3 font-semibold text-forge-bg hover:brightness-95"
            >
              Continue to dashboard
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PhaseChip({ phase }: { phase: Exclude<ProviderPhase, 'failed'> | 'connected' | 'skipped' }) {
  const map: Record<string, { label: string; cls: string }> = {
    checking: { label: 'Checking', cls: 'bg-forge-surface text-forge-muted' },
    connecting: { label: 'Connecting', cls: 'bg-forge-cyan/20 text-forge-cyan' },
    connected: { label: 'Connected', cls: 'bg-forge-lime/20 text-forge-lime' },
    skipped: { label: 'Skipped', cls: 'bg-forge-surface text-forge-muted' },
  };
  const m: { label: string; cls: string } = map[phase] ?? {
    label: 'Checking',
    cls: 'bg-forge-surface text-forge-muted',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>{m.label}</span>
  );
}

