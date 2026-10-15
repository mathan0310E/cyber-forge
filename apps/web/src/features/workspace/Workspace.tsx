import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BuildJob } from '@wolf-forge/shared-types';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiClientError, encodeFilePath, openSse } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { WolfMark } from '../../components/PublicLayout';

interface FileInfo {
  path: string;
  size: number;
  language: string;
  editable: boolean;
}

const STAGE_LABELS: Record<string, string> = {
  Queued: 'Queued',
  Analyzing: 'Analyzing your request',
  Planning: 'Planning the site',
  Generating: 'Writing source files',
  Installing: 'Installing dependencies',
  Building: 'Building the site',
  Repairing: 'Repairing the build',
  StartingPreview: 'Starting preview',
  PreviewReady: 'Preview ready',
  Failed: 'Build failed',
  Cancelled: 'Cancelled',
};

function prettyStage(st: string | null): string {
  if (!st) return '—';
  return STAGE_LABELS[st] ?? st;
}

export function Workspace() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const location = useLocation();
  const { jobId } = (location.state as { jobId?: string } | null) ?? {};

  const [project, setProject] = useState<{
    name: string;
    framework: string;
    currentVersionId: string | null;
    previewUrl: string | null;
  } | null>(null);
  const [job, setJob] = useState<BuildJob | null>(null);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [fileLoading, setFileLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<Array<{ role: 'user' | 'system'; text: string }>>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [viewport, setViewport] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [refreshKey, setRefreshKey] = useState(0);

  const token = localStorage.getItem('wf_token') ?? '';
  const workspaceProject = project;

  // Load project + its latest build + files.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const p = await api.get<{
          name: string;
          framework: string;
          currentVersionId: string | null;
          previewUrl: string | null;
        }>(`/projects/${projectId}`);
        if (!active) return;
        setProject(p);
        if (p.previewUrl) setPreviewUrl(p.previewUrl);
        const f = await api.get<{ files: FileInfo[]; fileCount: number }>(`/projects/${projectId}/files`);
        if (!active) return;
        setFiles(f.files);
        // Pick the editable-looking entry by default.
        const pick =
          f.files.find((x) => x.path.endsWith('.tsx')) ??
          f.files.find((x) => x.path.endsWith('.ts')) ??
          f.files.find((x) => x.editable) ??
          f.files[0];
        if (pick) setSelectedFile(pick.path);
      } catch (e) {
        window.alert(e instanceof Error ? e.message : 'Failed to load project.');
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  // After the build settles, refresh the project (preview URL) and the file tree.
  const refreshProjectState = useCallback(async () => {
    try {
      const p = await api.get<{
        name: string;
        framework: string;
        currentVersionId: string | null;
        previewUrl: string | null;
      }>(`/projects/${projectId}`);
      setProject(p);
      if (p.previewUrl) setPreviewUrl(p.previewUrl);
      const f = await api.get<{ files: FileInfo[]; fileCount: number }>(`/projects/${projectId}/files`);
      setFiles(f.files);
      setSelectedFile((prev) => {
        if (prev) return prev;
        const pick =
          f.files.find((x) => x.path.endsWith('.tsx')) ??
          f.files.find((x) => x.path.endsWith('.ts')) ??
          f.files.find((x) => x.editable) ??
          f.files[0];
        return pick ? pick.path : null;
      });
    } catch {
      /* ignore transient failures */
    }
  }, [projectId]);

  // Track the active job via SSE. If none is running, poll the last build.
  useEffect(() => {
    if (!jobId && !project) return;
    const watchBuild = async (buildId: string) => {
      try {
        const j = await api.get<BuildJob>(`/builds/${buildId}`);
        setJob(j);
        if (j.state === 'PreviewReady' || j.state === 'Failed' || j.state === 'Cancelled') {
          await refreshProjectState();
        }
      } catch {
        /* polling fallback */
      }
    };

    if (jobId) {
      const close = openSse(`/builds/${jobId}/events`, token, {
        onEvent: (type, payload) => {
          if (type === 'build-event') {
            const ev = payload as {
              type: string;
              state: string;
              message?: string;
              data?: Record<string, unknown>;
            };
            setHistory((h) => {
              const last = h[h.length - 1];
              const entry = { role: 'system' as const, text: ev.message ?? ev.state };
              if (last && last.role === 'system' && ev.type !== 'log') {
                return [...h.slice(0, -1), entry];
              }
              return [...h, entry];
            });
            setJob((prev) => {
              const st = ev.state as BuildJob['state'];
              return prev ? { ...prev, state: st } : prev;
            });
            if (
              ev.state === 'PreviewReady' ||
              ev.state === 'Failed' ||
              ev.state === 'Cancelled'
            ) {
              void refreshProjectState();
            }
            if (ev.type === 'preview-ready' && ev.data?.url) {
              setPreviewUrl(String(ev.data.url));
            }
            const modelName = ev.data?.model;
            if (modelName) {
              setHistory((h) => [
                ...h,
                { role: 'system', text: `Using ${String(modelName)}` },
              ]);
            }
          } else if (type === 'hello') {
            const h = payload as { state?: string };
            if (h.state) {
              setJob((prev) => (prev ? { ...prev, state: h.state as BuildJob['state'] } : prev));
            }
          }
        },
        onError: () => {
          /* SSE reconnects automatically */
        },
      });
      void watchBuild(jobId);
      const t = window.setInterval(() => {
        void watchBuild(jobId);
      }, 4000);
      return () => {
        close();
        window.clearInterval(t);
      };
    }

    // No job id (fresh visit) — poll the project's settled state so a build
    // started elsewhere shows up.
    const t2 = window.setInterval(() => {
      void refreshProjectState();
    }, 3000);
    return () => window.clearInterval(t2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, projectId, project?.currentVersionId]);

  // Load selected file content.
  useEffect(() => {
    if (!selectedFile) return;
    let active = true;
    setFileLoading(true);
    setFileContent('');
    api
      .getText(`/projects/${projectId}/files/${encodeFilePath(selectedFile)}`)
      .then((text) => {
        if (active) setFileContent(text);
      })
      .catch(() => {
        if (active) setFileContent('// Unable to load this file.');
      })
      .finally(() => {
        if (active) setFileLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, selectedFile]);

  const refine = useCallback(async () => {
    const instruction = message.trim();
    if (!instruction) return;
    setHistory((h) => [...h, { role: 'user', text: instruction }]);
    setMessage('');
    try {
      const r = await api.post<{ job: BuildJob }>(`/builds/projects/${projectId}/builds`, {
        operation: 'refine',
        instruction,
      });
      setJob(r.job);
      // Attach to the new job's event stream.
      const close = openSse(`/builds/${r.job.id}/events`, token, {
        onEvent: (type, payload) => {
          if (type === 'build-event') {
            const ev = payload as {
              type: string;
              state: string;
              message?: string;
              data?: Record<string, unknown>;
            };
            const text = ev.message ?? ev.state;
            if (ev.type !== 'log') {
              setHistory((h) => {
                const last = h[h.length - 1];
                if (last && last.role === 'system' && last.text !== text) {
                  return [...h.slice(0, -1), { role: 'system', text }];
                }
                return [...h, { role: 'system', text }];
              });
            }
            if (ev.type === 'preview-ready' && ev.data?.url) {
              setPreviewUrl(String(ev.data.url));
            }
            setJob((prev) => {
              const st = ev.state as BuildJob['state'];
              return prev ? { ...prev, state: st } : prev;
            });
          }
        },
      });
      window.addEventListener('beforeunload', close, { once: true });
    } catch (e) {
      setHistory((h) => [
        ...h,
        { role: 'system' as const, text: e instanceof ApiClientError ? e.message : 'Refine failed.' },
      ]);
    }
  }, [message, projectId, token]);

  const saveFile = useCallback(async () => {
    if (!selectedFile) return;
    try {
      await api.put(`/projects/${projectId}/files/${encodeFilePath(selectedFile)}`, {
        content: fileContent,
      });
      setHistory((h) => [...h, { role: 'system', text: `Saved ${selectedFile}. Trigger a rebuild to preview changes.` }]);
    } catch (e) {
      setHistory((h) => [
        ...h,
        { role: 'system', text: e instanceof ApiClientError ? e.message : 'Could not save file.' },
      ]);
    }
  }, [selectedFile, fileContent, projectId]);

  const exportZip = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'Export failed.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${workspaceProject?.name ?? 'wolf-forge-project'}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Export failed.');
    }
  }, [projectId, token, workspaceProject]);

  const reloadPreview = useCallback(() => setRefreshKey((k) => k + 1), []);
  const previewSrc = useMemo(() => {
    if (!previewUrl) return null;
    return previewUrl;
  }, [previewUrl]);

  const viewportWidth =
    viewport === 'mobile' ? 'w-[360px]' : viewport === 'tablet' ? 'w-[640px] max-w-full' : 'w-full';

  return (
    <div className="flex h-screen flex-col bg-forge-bg">
      {/* Toolbar */}
      <header className="flex shrink-0 items-center justify-between border-b border-forge-border px-4 py-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/app')}
            aria-label="Back to dashboard"
            className="rounded-md p-1 text-forge-muted hover:text-forge-text"
          >
            ←
          </button>
          <WolfMark className="h-6 w-6" />
          <span className="max-w-[220px] truncate font-display text-base font-bold">
            {workspaceProject?.name ?? 'Project'}
          </span>
          {job && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                job.state === 'PreviewReady'
                  ? 'bg-forge-lime/15 text-forge-lime'
                  : job.state === 'Failed' || job.state === 'Cancelled'
                    ? 'bg-forge-orange/15 text-forge-orange'
                    : 'bg-forge-cyan/15 text-forge-cyan'
              }`}
            >
              {job.state}
            </span>
          )}
          {job?.cancelRequested && (
            <span className="text-[11px] text-forge-muted">cancelling…</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={reloadPreview}
            className="rounded-md border border-forge-border px-2.5 py-1 text-forge-muted hover:text-forge-text"
          >
            Reload preview
          </button>
          <button
            type="button"
            onClick={() => void exportZip()}
            className="rounded-md border border-forge-border px-2.5 py-1 text-forge-muted hover:text-forge-text"
          >
            Export ZIP
          </button>
          <span className="hidden rounded-md border border-forge-border px-2.5 py-1 text-forge-muted sm:block">
            {user?.displayName ?? user?.email}
          </span>
        </div>
      </header>

      {/* Body */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(240px,0.9fr)_minmax(0,2fr)_minmax(220px,0.9fr)]">
        {/* AI / build log */}
        <aside className="flex min-h-0 flex-col border-r border-forge-border bg-forge-panel">
          <div className="flex items-center justify-between border-b border-forge-border px-3 py-2 text-xs font-semibold uppercase tracking-widest text-forge-muted">
            <span>Build &amp; refine</span>
            {job && <span className="normal-case tracking-normal">{Math.round(job.progress * 100)}%</span>}
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {history.length === 0 && (
              <p className="text-xs leading-relaxed text-forge-muted">
                Describe a change to refine this site — e.g. “Make the navigation sticky and change
                the primary accent to lime.”
              </p>
            )}
            {history.map((h, i) => (
              <div
                key={i}
                className={`rounded-lg px-3 py-2 text-sm ${
                  h.role === 'user'
                    ? 'bg-forge-surface text-forge-text'
                    : 'bg-forge-cyan/10 text-forge-cyan'
                }`}
              >
                {h.text}
              </div>
            ))}
            {job && job.state === 'Generating' && (
              <div className="flex items-center gap-2 text-xs text-forge-muted">
                <span className="h-2 w-2 animate-pulse rounded-full bg-forge-lime" />
                {prettyStage(job.state)}
              </div>
            )}
            {(job?.state === 'Failed' || job?.state === 'Cancelled') && (
              <div className="rounded-lg border border-forge-orange/40 bg-forge-orange/10 px-3 py-2 text-sm text-forge-orange">
                {job.errorSummary ?? prettyStage(job.state)}
              </div>
            )}
          </div>
          <div className="border-t border-forge-border p-3">
            <label className="sr-only" htmlFor="instruction">Refine instruction</label>
            <textarea
              id="instruction"
              value={message}
              rows={2}
              placeholder="Make the hero shorter / buttons orange…"
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void refine();
              }}
              className="w-full resize-none rounded-lg border border-forge-border bg-forge-surface px-3 py-2 text-sm outline-none focus:border-forge-cyan"
            />
            <div className="mt-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() => void refine()}
                disabled={!message.trim()}
                className="rounded-md bg-forge-lime px-3 py-1.5 text-sm font-semibold text-forge-bg hover:brightness-95 disabled:opacity-40"
              >
                Refine
              </button>
              <button
                type="button"
                onClick={() => void refreshProjectState()}
                className="text-xs text-forge-muted hover:text-forge-text"
              >
                Refresh state
              </button>
            </div>
          </div>
        </aside>

        {/* Preview */}
        <section className="flex min-h-0 flex-col bg-forge-bg">
          <div className="flex shrink-0 items-center justify-between border-b border-forge-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-forge-muted">Live preview</span>
            <div className="flex gap-1">
              {(['desktop', 'tablet', 'mobile'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={viewport === v}
                  onClick={() => setViewport(v)}
                  className={`rounded px-2 py-1 text-xs ${viewport === v ? 'bg-forge-surface text-forge-text' : 'text-forge-muted'}`}
                >
                  {v}
                </button>
              ))}
            </div>
            {previewUrl && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-forge-border px-2 py-1 text-xs text-forge-muted hover:text-forge-text"
              >
                Open ↗
              </a>
            )}
          </div>
          <div className={`flex min-h-0 flex-1 justify-center overflow-auto p-3 ${viewportWidth}`}>
            {previewSrc ? (
              <iframe
                key={`${previewSrc}-${refreshKey}`}
                src={previewSrc}
                title="Live generated site preview"
                className="h-full w-full rounded-lg border border-forge-border bg-white"
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
                <p className="font-display text-lg text-forge-muted">
                  {job && job.state === 'PreviewReady'
                    ? 'Preview ready — open it in a new tab above.'
                    : 'No preview yet.'}
                </p>
                {job && job.state !== 'PreviewReady' && (
                  <p className="text-xs text-forge-muted">Current stage: {prettyStage(job.state)}</p>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Files + editor */}
        <aside className="flex min-h-0 flex-col border-l border-forge-border bg-forge-panel">
          <div className="shrink-0 border-b border-forge-border px-3 py-2 text-xs font-semibold uppercase tracking-widest text-forge-muted">
            Source ({files.length})
          </div>
          <div className="max-h-40 shrink-0 overflow-y-auto border-b border-forge-border">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                aria-current={selectedFile === f.path}
                onClick={() => setSelectedFile(f.path)}
                className={`block w-full truncate px-3 py-1.5 text-left font-mono text-xs transition-colors ${
                  selectedFile === f.path
                    ? 'bg-forge-surface text-forge-cyan'
                    : 'text-forge-muted hover:text-forge-text'
                }`}
              >
                {f.path}
              </button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {selectedFile ? (
              <>
                <div className="flex shrink-0 items-center justify-between border-b border-forge-border px-3 py-1.5">
                  <span className="truncate font-mono text-xs text-forge-muted">{selectedFile}</span>
                  <button
                    type="button"
                    onClick={() => void saveFile()}
                    className={`rounded px-2 py-0.5 text-xs font-semibold ${
                      fileLoading ? 'bg-forge-border text-forge-muted' : 'bg-forge-lime text-forge-bg hover:brightness-95'
                    }`}
                    disabled={fileLoading}
                  >
                    Save
                  </button>
                </div>
                <textarea
                  key={selectedFile}
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  spellCheck={false}
                  aria-label={`Editor for ${selectedFile}`}
                  className="min-h-0 flex-1 resize-none overflow-auto bg-forge-surface p-3 font-mono text-xs leading-relaxed text-forge-text outline-none"
                />
              </>
            ) : (
              <p className="p-3 text-xs text-forge-muted">No files yet. Run a build first.</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}