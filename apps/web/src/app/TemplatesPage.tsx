import { Link, useNavigate } from 'react-router-dom';
import { templateSummaries, type TemplatePreview } from '../lib/templates';

export function TemplatesPage() {
  const navigate = useNavigate();
  const templates = templateSummaries();

  const useTemplate = (category: string) => {
    navigate('/app/new', { state: { category } });
  };

  return (
    <div className="min-h-screen bg-forge-bg">
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl mb-4">
            Choose a template
          </h2>
          <p className="text-lg text-forge-muted">
            Start from a pre-designed layout. Pick a template below and we&rsquo;ll scaffold a real,
            editable site from it &mdash; no AI provider key required.
          </p>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {templates.map((t) => (
            <TemplateCard key={t.category} template={t} onUse={useTemplate} />
          ))}
        </div>
      </section>
    </div>
  );
}

interface TemplateCardProps {
  template: TemplatePreview;
  onUse: (category: string) => void;
}

function TemplateCard({ template, onUse }: TemplateCardProps) {
  const isDark = template.category === 'portfolio' || template.category === 'landing-page' || template.category === 'saas-dashboard' || template.category === 'event' || template.category === 'custom';

  return (
    <Link
      to="#"
      onClick={(e) => {
        e.preventDefault();
        onUse(template.category);
      }}
      className="group block rounded-xl border border-forge-border bg-forge-panel hover:border-forge-cyan/50 transition-colors"
    >
      {/* Preview image */}
      <div className="aspect-video rounded-t-xl overflow-hidden border-b border-forge-border relative">
        <img
          src={template.image}
          alt={`${template.label} preview`}
          className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-300"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-black/40 group-hover:bg-black/20 transition-colors flex items-center justify-center">
          <span className="px-3 py-1 rounded-md bg-forge-bg/90 backdrop-blur text-xs font-semibold text-forge-text border border-forge-border/50">
            Open template
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="font-display text-lg font-semibold leading-tight group-hover:text-forge-cyan">
            {template.label}
          </h3>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
              isDark
                ? 'border-forge-surface text-forge-text bg-forge-surface/50'
                : 'border-forge-border text-forge-muted bg-forge-surface'
            }`}
          >
            {isDark ? 'Dark' : 'Light'}
          </span>
        </div>
        <p className="text-sm text-forge-muted line-clamp-3 mb-4">{template.description}</p>

        <div className="mb-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-forge-muted">
            Example prompts
          </p>
          <ul className="space-y-1 text-xs text-forge-muted list-disc list-inside">
            {template.examplePrompts.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between text-xs text-forge-muted border-t border-forge-border pt-3">
          <span>{template.pages.length} page{template.pages.length !== 1 ? 's' : ''}</span>
          <span className="font-semibold">{template.headingFont.split(',')[0]?.replace(/'/g, '') ?? ''}</span>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onUse(template.category);
          }}
          className="mt-4 w-full rounded-lg bg-forge-lime px-4 py-2.5 text-xs font-bold text-forge-bg hover:brightness-95 transition-colors"
        >
          Use this template
        </button>
      </div>
    </Link>
  );
}
