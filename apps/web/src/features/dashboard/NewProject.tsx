import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiClientError } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';

const CATEGORIES = [
  'portfolio',
  'business',
  'landing-page',
  'blog',
  'ecommerce',
  'saas-dashboard',
  'education',
  'event',
  'documentation',
  'custom',
];

const FRAMEWORKS = ['vite-react-ts', 'static-html'];

interface NewProjectResult {
  project: { id: string };
  job: { id: string } | null;
}

export function NewProject() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const state = location.state as { prompt?: string; category?: string } | null;
  const initialPrompt = state?.prompt ?? '';
  const initialCategory = (state?.category as
    | 'portfolio'
    | 'business'
    | 'landing-page'
    | 'blog'
    | 'ecommerce'
    | 'saas-dashboard'
    | 'education'
    | 'event'
    | 'documentation'
    | 'custom') ?? 'landing-page';

  const [prompt, setPrompt] = useState(initialPrompt);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>(initialCategory);
  const [framework, setFramework] = useState('vite-react-ts');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (prompt.trim().length < 10) {
      setError('Describe the website you want in at least 10 characters.');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<NewProjectResult>('/projects', {
        name: name.trim() || prompt.trim().slice(0, 40) || 'Untitled project',
        prompt: prompt.trim(),
        category,
        framework,
        autoStart: true,
      });
      navigate(`/app/projects/${r.project.id}`, { state: { jobId: r.job?.id } });
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Could not create project.');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-forge-bg">
      <header className="border-b border-forge-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <button
            type="button"
            onClick={() => navigate('/app')}
            className="text-sm text-forge-muted hover:text-forge-text"
          >
            ← Back to projects
          </button>
          <span className="text-sm text-forge-muted">{user?.email}</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="font-display text-3xl font-bold tracking-tight">Forge a new project</h1>
        <p className="mt-1 text-sm text-forge-muted">
          Describe the website. Wolf Forge plans, generates, builds, and previews it — no provider
          key needed.
        </p>

        <label className="mt-8 block text-sm font-semibold" htmlFor="prompt">
          What should we build?
        </label>
        <textarea
          id="prompt"
          value={prompt}
          rows={6}
          placeholder="e.g. Build a modern portfolio website for a cybersecurity student with a dark background, neon green accents, and a contact form."
          onChange={(e) => setPrompt(e.target.value)}
          className="mt-2 w-full resize-y rounded-xl border border-forge-border bg-forge-panel p-4 text-sm outline-none transition-colors focus:border-forge-cyan"
        />

        <label className="mt-6 block text-sm font-semibold" htmlFor="name">
          Project name <span className="font-normal text-forge-muted">(optional)</span>
        </label>
        <input
          id="name"
          value={name}
          placeholder="Leave blank to use the prompt"
          onChange={(e) => setName(e.target.value)}
          className="mt-2 w-full rounded-lg border border-forge-border bg-forge-panel px-3 py-2 text-sm outline-none focus:border-forge-cyan"
        />

        <fieldset className="mt-6">
          <legend className="text-sm font-semibold">Category</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  category === c
                    ? 'border-forge-lime bg-forge-lime/15 text-forge-lime'
                    : 'border-forge-border text-forge-muted hover:text-forge-text'
                }`}
              >
                {c.replace('-', ' ')}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-6">
          <legend className="text-sm font-semibold">Framework</legend>
          <div className="mt-2 flex gap-2">
            {FRAMEWORKS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFramework(f)}
                aria-pressed={framework === f}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  framework === f
                    ? 'border-forge-cyan bg-forge-cyan/15 text-forge-cyan'
                    : 'border-forge-border text-forge-muted hover:text-forge-text'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </fieldset>

        {error && (
          <p role="alert" className="mt-6 rounded-lg border border-forge-orange/40 bg-forge-orange/10 px-4 py-3 text-sm text-forge-orange">
            {error}
          </p>
        )}

        <div className="mt-8 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-lg bg-forge-lime px-6 py-3 font-semibold text-forge-bg hover:brightness-95 disabled:opacity-50"
          >
            {busy ? 'Forging…' : 'Forge it'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/app/new')}
            className="px-4 py-3 text-sm text-forge-muted hover:text-forge-text"
          >
            Clear
          </button>
        </div>
      </main>
    </div>
  );
}