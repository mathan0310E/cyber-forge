import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiClientError } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { WolfMark } from '../../components/PublicLayout';

interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  framework: string;
  status: string;
  updatedAt: string;
  createdAt: string;
  currentVersionId: string | null;
}

interface ListResponse {
  projects: ProjectSummary[];
  nextCursor: string | null;
}

const SUGGESTED = [
  'Portfolio for a photographer with a bold dark layout',
  'SaaS landing page for a note-taking app with a pricing section',
  'Event registration page for a local tech conference',
];

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string, q?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50', sort: 'updatedAt', direction: 'desc' });
      if (cursor) params.set('cursor', cursor);
      if (q) params.set('search', q);
      const r = await api.get<ListResponse>(`/projects?${params.toString()}`);
      setProjects((prev) => (cursor ? [...prev, ...r.projects] : r.projects));
      setNextCursor(r.nextCursor);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Could not load projects.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteProject = async (id: string) => {
    if (!window.confirm('Delete this project? This cannot be undone.')) return;
    setBusyId(id);
    try {
      await api.delete(`/projects/${id}`);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (id: string) => {
    setBusyId(id);
    try {
      const r = await api.post<{ project: ProjectSummary }>(`/projects/${id}/duplicate`, {});
      setProjects((prev) => [r.project, ...prev]);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Duplicate failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="min-h-screen bg-forge-bg">
      <header className="border-b border-forge-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <WolfMark className="h-7 w-7" />
            <span className="font-display text-lg font-bold">
              Wolf <span className="text-forge-orange">Forge</span>
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="max-w-[180px] truncate text-forge-muted">
              {user?.displayName ?? user?.email ?? 'User'}
            </span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-md border border-forge-border px-3 py-1.5 text-forge-muted hover:text-forge-text"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Your projects</h1>
            <p className="mt-1 text-sm text-forge-muted">Describe, generate, refine, deploy.</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/app/new')}
            className="rounded-lg bg-forge-lime px-5 py-2.5 font-semibold text-forge-bg hover:brightness-95"
          >
            + New project
          </button>
        </div>

        <div className="mt-6">
          <label className="sr-only" htmlFor="search">Search projects</label>
          <input
            id="search"
            value={search}
            placeholder="Search projects…"
            onChange={(e) => {
              setSearch(e.target.value);
              void load(undefined, e.target.value.trim() || undefined);
            }}
            className="w-full max-w-sm rounded-lg border border-forge-border bg-forge-panel px-3 py-2 text-sm outline-none focus:border-forge-cyan"
          />
        </div>

        {error && (
          <p role="alert" className="mt-6 rounded-lg border border-forge-orange/40 bg-forge-orange/10 px-4 py-3 text-sm text-forge-orange">
            {error}
          </p>
        )}

        {loading && projects.length === 0 ? (
          <p className="mt-10 text-center text-sm text-forge-muted">Loading your projects…</p>
        ) : projects.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed border-forge-border bg-forge-panel/50 p-10 text-center">
            <p className="font-display text-xl font-semibold">No projects yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-forge-muted">
              Describe a website and Wolf Forge will scaffold real source files and give you a live
              preview.
            </p>
            <div className="mx-auto mt-6 max-w-md space-y-2 text-left">
              {SUGGESTED.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => navigate('/app/new', { state: { prompt: p } })}
                  className="block w-full rounded-lg border border-forge-border bg-forge-surface px-3 py-2 text-left text-sm text-forge-muted hover:border-forge-cyan/60 hover:text-forge-text"
                >
                  “{p}”
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <li
                  key={p.id}
                  className="group rounded-xl border border-forge-border bg-forge-panel p-4 transition-colors hover:border-forge-cyan/50"
                >
                  <Link to={`/app/projects/${p.id}`} className="block">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="font-display text-lg font-semibold leading-tight group-hover:text-forge-cyan">
                        {p.name}
                      </h2>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          p.status === 'ready'
                            ? 'bg-forge-lime/15 text-forge-lime'
                            : p.status === 'building'
                              ? 'bg-forge-cyan/15 text-forge-cyan'
                              : 'bg-forge-border text-forge-muted'
                        }`}
                      >
                        {p.status}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 min-h-[2.5rem] text-sm text-forge-muted">
                      {p.description || 'No description'}
                    </p>
                    <div className="mt-3 flex items-center justify-between text-xs text-forge-muted">
                      <span>
                        {p.framework} · {p.category}
                      </span>
                      <span>{timeAgo(p.updatedAt)}</span>
                    </div>
                  </Link>
                  <div className="mt-3 flex gap-2 border-t border-forge-border pt-3 text-xs">
                    <button
                      type="button"
                      onClick={() => void duplicate(p.id)}
                      disabled={busyId === p.id}
                      className="text-forge-muted hover:text-forge-cyan disabled:opacity-50"
                    >
                      Duplicate
                    </button>
                    <span className="text-forge-border">·</span>
                    <button
                      type="button"
                      onClick={() => void deleteProject(p.id)}
                      disabled={busyId === p.id}
                      className="text-forge-muted hover:text-forge-orange disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {nextCursor && (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => void load(nextCursor)}
                  className="rounded-lg border border-forge-border px-4 py-2 text-sm text-forge-muted hover:text-forge-text"
                >
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}