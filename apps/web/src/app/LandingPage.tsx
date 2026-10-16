import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';
import { WolfMark } from '../components/PublicLayout';

const EXAMPLE_PROMPTS = [
  'Build a modern portfolio website for a cybersecurity student with a dark background, neon green accents, animated project cards, and a contact form.',
  'Create a landing page for a boutique coffee roastery with warm tones, a story section, and a menu.',
  'Make a documentation-style site for an open-source toolkit with a sidebar, search placeholder, and code examples.',
];

const FEATURES = [
  {
    k: '01',
    title: 'Describe',
    body: 'Type what you want in plain language. No framework knowledge needed.',
    accent: 'text-forge-lime',
  },
  {
    k: '02',
    title: 'Generate',
    body: 'Wolf Forge turns your words into real source files — planned, scaffolded, and validated.',
    accent: 'text-forge-cyan',
  },
  {
    k: '03',
    title: 'Refine',
    body: '“Make the hero shorter.” “Buttons orange.” Follow-up edits patch the exact files.',
    accent: 'text-forge-purple',
  },
  {
    k: '04',
    title: 'Deploy',
    body: 'Export the ZIP, push to GitHub, or deploy to a supported host when configured.',
    accent: 'text-forge-orange',
  },
];

export function LandingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const startForge = (prompt?: string) => {
    navigate('/app/new', { state: { prompt } });
  };

  return (
    <div className="feature-grid">
      {/* Hero */}
      <section className="relative mx-auto max-w-6xl px-4 pb-16 pt-12 sm:pt-16">
        <div className="grid items-center gap-10 lg:grid-cols-[1.25fr_1fr]">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-forge-border bg-forge-panel px-3 py-1 text-xs font-medium uppercase tracking-widest text-forge-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-forge-lime" aria-hidden="true" />
              Free-first AI website builder
            </p>
            <h1 className="font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
              Your next big idea
              <br />
              <span className="text-forge-cyan">starts here.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-forge-muted">
              Describe the website you imagine. Wolf Forge turns your words into real, editable
              code — with a live preview, version history, and export.
            </p>

            <div className="mt-8 space-y-3">
              <textarea
                aria-label="Describe the website you want to build"
                className="w-full resize-y rounded-xl border border-forge-border bg-forge-panel p-4 text-sm text-forge-text outline-none transition-colors focus:border-forge-cyan"
                rows={3}
                placeholder="e.g. Build a portfolio for a cybersecurity student with neon accents and a contact form…"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') startForge();
                }}
              />
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => startForge()}
                  className="rounded-lg bg-forge-orange px-6 py-3 font-semibold text-forge-bg transition-all hover:-translate-y-0.5 hover:shadow-[0_0_24px_rgba(255,138,36,0.35)] focus-visible:outline-2 focus-visible:outline-forge-orange focus-visible:outline-offset-2"
                >
                  Forge my website
                </button>
                <Link
                  to={user ? '/app' : '/signup'}
                  className="text-sm font-medium text-forge-muted underline-offset-4 hover:text-forge-text hover:underline"
                >
                  {user ? 'Open your dashboard' : 'Free to start — no AI credits required'}
                </Link>
              </div>
            </div>

            <div className="mt-8" aria-label="Example prompts">
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-forge-muted">
                Try an example
              </p>
              <div className="space-y-2">
                {EXAMPLE_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => startForge(p)}
                    className="block w-full rounded-lg border border-forge-border bg-forge-panel/70 px-3 py-2 text-left text-sm text-forge-muted transition-colors hover:border-forge-cyan/60 hover:text-forge-text focus-visible:outline-2 focus-visible:outline-forge-cyan"
                  >
                    “{p.length > 90 ? `${p.slice(0, 90)}…` : p}”
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Wolf illustration + preview mock */}
          <div className="relative mx-auto w-full max-w-md" aria-hidden="true">
            <div className="absolute -left-4 -top-4 h-24 w-24 rounded-full border-2 border-dashed border-forge-purple/50 animate-float-slow" />
            <div className="absolute -right-2 top-10 h-10 w-10 rotate-12 rounded-full bg-forge-orange/20 animate-float-slow" style={{ ['--rot' as string]: '12deg' }} />
            <div className="relative rounded-2xl border border-forge-border bg-forge-panel p-5 shadow-2xl shadow-black/40">
              <div className="flex items-center justify-between border-b border-forge-border pb-3">
                <div className="flex items-center gap-2">
                  <WolfMark className="h-6 w-6" />
                  <span className="font-display text-sm font-bold">neon-portfolio</span>
                </div>
                <div className="flex gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-forge-orange/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-forge-lime/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-forge-cyan/70" />
                </div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-lg bg-forge-surface p-4">
                  <div className="mb-2 h-3 w-2/3 rounded bg-forge-lime/80" />
                  <div className="h-2.5 w-full rounded bg-forge-border" />
                  <div className="mt-1.5 h-2.5 w-5/6 rounded bg-forge-border" />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="rounded-lg bg-forge-surface p-3">
                      <div className={`mb-2 h-8 rounded ${['bg-forge-cyan/60', 'bg-forge-purple/60', 'bg-forge-orange/60'][i] ?? ''}`} />
                      <div className="h-2 w-full rounded bg-forge-border" />
                      <div className="mt-1 h-2 w-3/4 rounded bg-forge-border" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="absolute -bottom-3 left-8 -rotate-2 rounded-md border border-forge-border bg-forge-bg px-3 py-1 font-display text-xs font-semibold text-forge-cyan animate-float-slow">
              real code, live preview
            </div>
          </div>
        </div>

        <p className="mt-14 max-w-2xl text-xs leading-relaxed text-forge-muted">
          <span className="font-semibold text-forge-text">Free-first strategy:</span> Wolf Forge
          routes generation to free AI models when configured, and falls back to a built-in
          deterministic template engine with no provider keys at all. We never silently switch to
          a paid model.
        </p>
      </section>

      {/* How it works */}
      <section className="border-y border-forge-border bg-forge-panel/40">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            From <span className="text-forge-orange">idea</span> to{' '}
            <span className="text-forge-lime">running website</span>
          </h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map(({ k, title, body, accent }) => (
              <div key={k} className="relative rounded-xl border border-forge-border bg-forge-surface p-5">
                <span className={`font-display text-3xl font-bold ${accent}`}>{k}</span>
                <h3 className="mt-3 font-display text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-forge-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What you can build */}
      <section className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="font-display text-3xl font-bold tracking-tight">Build any of these</h2>
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {[
            'Portfolio',
            'Business website',
            'Landing page',
            'Blog',
            'E-commerce storefront',
            'SaaS dashboard',
            'Educational site',
            'Event registration',
            'Documentation site',
            'Custom app',
          ].map((c) => (
            <div
              key={c}
              className="rounded-lg border border-forge-border bg-forge-panel px-4 py-3 text-center text-sm font-medium text-forge-muted transition-colors hover:border-forge-lime/50 hover:text-forge-text"
            >
              {c}
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-4 pb-20">
        <h2 className="font-display text-3xl font-bold tracking-tight">Questions</h2>
        <dl className="mt-8 space-y-5">
          {[
            ['Do I need an AI API key?', 'No. Without any provider configured the built-in template engine generates a real, runnable site from your prompt. Add an OpenRouter API key to unlock free-task-aware model routing.'],
            ['Is it really free?', 'The core workflow — generate, preview, edit, export — uses no paid AI. Free-first mode is enforced server-side: paid or unknown-cost models are never silently selected.'],
            ['Where does my code go?', 'Generated source lives in your own project, versioned, ready to export as a ZIP or push to GitHub when you connect the integration.'],
            ['Can I host it?', 'Export and self-host anywhere. A Vercel deployment integration is available when you configure deployment credentials.'],
          ].map(([q, a]) => (
            <div key={q} className="rounded-lg border border-forge-border bg-forge-panel p-5">
              <dt className="font-semibold">{q}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-forge-muted">{a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}