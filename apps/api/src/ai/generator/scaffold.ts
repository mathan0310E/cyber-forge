import type { ProjectFramework, WebsiteSpec } from '@wolf-forge/shared-types';

/**
 * Framework scaffolds.
 *
 * Every generated project is built on one of these scaffolds. The scaffold
 * provides the files that must be exactly right for the project to install and
 * build (config, entry point, toolchain). The AI fills in the content files.
 *
 * This split is what makes free-model output reliable: the model cannot break
 * the build by inventing a malformed tsconfig or a wrong Vite entry path,
 * because the scaffold owns those files and they are overwritten after
 * generation.
 */

export interface ScaffoldFile {
  path: string;
  content: string;
  /** Scaffold-owned files are re-written after AI generation and never patched. */
  owned: boolean;
}

export interface Scaffold {
  framework: ProjectFramework;
  installCommand: string;
  buildCommand: string;
  outputDir: string;
  /** Files that must exist for the project to build. */
  files: ScaffoldFile[];
  /** Content files the AI is expected to author. */
  contentPaths: string[];
  /** Command used to serve the built output for preview. */
  previewCommand: string;
  previewPort: number;
  staticHostable: boolean;
}

function pkgJson(deps: Record<string, string>, devDeps: Record<string, string>): string {
  return `${JSON.stringify(
    {
      name: 'wolf-forge-site',
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        dev: 'vite --host 127.0.0.1',
        build: 'tsc -b && vite build',
        preview: 'vite preview --host 127.0.0.1 --port 4173 --strictPort',
      },
      dependencies: deps,
      devDependencies: devDeps,
    },
    null,
    2,
  )}\n`;
}

const VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: false },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
`;

const TSCONFIG_NODE = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
`;

const TSCONFIG_ROOT = `{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
`;

const VITE_ENV_DTS = `/// <reference types="vite/client" />
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__SITE_TITLE__</title>
    <meta name="description" content="__SITE_DESCRIPTION__" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
`;

const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

const GITIGNORE = `node_modules
dist
.env
.env.local
*.local
.DS_Store
`;

/**
 * Minimal static file server used to preview the no-build scaffold. Shipping
 * our own server avoids `npx`, which would need network access in the sandbox.
 */
const STATIC_SERVE_SCRIPT = `import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.cwd());
const PORT = Number(process.env.PORT || 4173);

// If a production build output (dist) exists, serve it instead of the source
// tree so the preview reflects the built site.
const DIST = join(ROOT, 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const hasDist = await stat(DIST).then((s) => s.isDirectory()).catch(() => false);
    const base = hasDist ? DIST : ROOT;
    const target = normalize(join(base, pathname));
    // Refuse to serve anything outside the project root (or the dist dir).
    if (target !== base && !target.startsWith(base + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let file = target;
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(base, 'index.html');
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('preview listening on ' + PORT);
});
`;

/**
 * React + Vite + TypeScript scaffold.
 *
 * `main.tsx` and `App.tsx` are scaffold-owned so routing and the mount point
 * cannot be broken by the model. The AI authors `src/pages/*` and
 * `src/components/*` plus `src/styles/theme.css`.
 */
export function viteReactScaffold(spec: WebsiteSpec): Scaffold {
  const deps: Record<string, string> = { react: '^18.3.1', 'react-dom': '^18.3.1' };
  const devDeps: Record<string, string> = {
    '@types/react': '^18.3.18',
    '@types/react-dom': '^18.3.5',
    '@vitejs/plugin-react': '^4.3.4',
    autoprefixer: '^10.4.20',
    postcss: '^8.4.49',
    tailwindcss: '^3.4.17',
    typescript: '^5.7.3',
    vite: '^5.4.11',
  };

  const routes = spec.pages.map((p) => ({
    name: p.name,
    route: p.route,
    component: toComponentName(p.name),
  }));

  const appTsx = `import { useEffect, useState } from 'react';
import './styles/theme.css';
import { Home } from './pages/Home';
${routes
  .filter((r) => r.route !== '/')
  .map((r) => `import { ${r.component} } from './pages/${r.component}';`)
  .join('\n')}

const ROUTES: Record<string, () => JSX.Element> = {
${routes.map((r) => `  '${r.route}': ${r.component},`).join('\n')}
};

function currentRoute(): string {
  const hash = window.location.hash.replace(/^#/, '');
  const path = hash.length > 0 ? hash : window.location.pathname;
  return ROUTES[path] ? path : '/';
}

export default function App() {
  const [route, setRoute] = useState(currentRoute());

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, []);

  const Page = ROUTES[route] ?? Home;

  return (
    <div className="wolf-forge-app">
      <Nav currentRoute={route} />
      <main id="main">
        <Page />
      </main>
      <Footer />
    </div>
  );
}

function Nav({ currentRoute: active }: { currentRoute: string }) {
  return (
    <header className="wf-nav">
      <a className="wf-brand" href="#/">${escapeText(spec.title)}</a>
      <nav aria-label="Main">
        ${routes
          .map(
            (r) =>
              `<a className={active === '${r.route}' ? 'wf-nav-link is-active' : 'wf-nav-link'} href="#${r.route}">${escapeText(r.name)}</a>`,
          )
          .join('\n        ')}
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="wf-footer">
      <p>${escapeText(spec.title)} — built with Wolf Forge.</p>
    </footer>
  );
}
`;

  const mainTsx = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root was not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

  // A baseline theme so the project renders even if the model's CSS is weak.
  const themeCss = buildThemeCss(spec);

  return {
    framework: 'vite-react-ts',
    installCommand: 'npm install --no-audit --no-fund',
    buildCommand: 'npm run build',
    // Previews are served by Wolf Forge's own tiny static server rather than
    // `vite preview`, so the preview process needs no node_modules and no network.
    previewCommand: 'node .wolf-forge-serve.mjs',
    previewPort: 4173,
    outputDir: 'dist',
    staticHostable: true,
    contentPaths: [
      ...spec.pages.map((p) => `src/pages/${toComponentName(p.name)}.tsx`),
      ...spec.components.map((c) => c.path),
      'src/styles/theme.css',
    ],
    files: [
      { path: 'package.json', content: pkgJson(deps, devDeps), owned: true },
      { path: 'vite.config.ts', content: VITE_CONFIG, owned: true },
      { path: 'tsconfig.json', content: TSCONFIG_ROOT, owned: true },
      { path: 'tsconfig.app.json', content: TSCONFIG, owned: true },
      { path: 'tsconfig.node.json', content: TSCONFIG_NODE, owned: true },
      { path: 'tailwind.config.js', content: TAILWIND_CONFIG, owned: true },
      { path: 'postcss.config.js', content: POSTCSS_CONFIG, owned: true },
      { path: 'src/vite-env.d.ts', content: VITE_ENV_DTS, owned: true },
      { path: 'src/main.tsx', content: mainTsx, owned: true },
      { path: 'src/App.tsx', content: appTsx, owned: true },
      { path: '.wolf-forge-serve.mjs', content: STATIC_SERVE_SCRIPT, owned: true },
      { path: 'src/styles/theme.css', content: themeCss, owned: false },
      {
        path: 'index.html',
        content: INDEX_HTML.replace('__SITE_TITLE__', escapeText(spec.title)).replace(
          '__SITE_DESCRIPTION__',
          escapeText(spec.description),
        ),
        owned: true,
      },
      { path: '.gitignore', content: GITIGNORE, owned: true },
    ],
  };
}

/** Static HTML scaffold for users who want no build step at all. */
export function staticHtmlScaffold(spec: WebsiteSpec): Scaffold {
  return {
    framework: 'static-html',
    installCommand: '',
    buildCommand: '',
    previewCommand: 'node .wolf-forge-serve.mjs',
    previewPort: 4173,
    outputDir: '.',
    staticHostable: true,
    contentPaths: ['index.html', 'styles.css'],
    files: [
      { path: '.wolf-forge-serve.mjs', content: STATIC_SERVE_SCRIPT, owned: true },
      { path: '.gitignore', content: GITIGNORE, owned: true },
      {
        path: 'index.html',
        content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeText(spec.title)}</title>
    <meta name="description" content="${escapeText(spec.description)}" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="wf-nav">
      <a class="wf-brand" href="./index.html">${escapeText(spec.title)}</a>
    </header>
    <main>
      <h1>${escapeText(spec.title)}</h1>
      <p>${escapeText(spec.description)}</p>
    </main>
    <footer class="wf-footer"><p>Built with Wolf Forge.</p></footer>
  </body>
</html>
`,
        owned: false,
      },
      { path: 'styles.css', content: buildThemeCss(spec), owned: false },
    ],
  };
}

export function buildScaffold(spec: WebsiteSpec): Scaffold {
  return spec.framework === 'static-html' ? staticHtmlScaffold(spec) : viteReactScaffold(spec);
}

/** Baseline CSS using the spec's design tokens, so the page is never unstyled. */
export function buildThemeCss(spec: WebsiteSpec): string {
  const d = spec.design;
  return `:root {
  --wf-bg: ${d.background};
  --wf-surface: ${d.surface};
  --wf-text: ${d.text};
  --wf-text-muted: ${d.textMuted};
  --wf-primary: ${d.primary};
  --wf-accent: ${d.accent};
  --wf-radius: ${d.radius};
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--wf-bg);
  color: var(--wf-text);
  font-family: ${d.bodyFont};
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4 {
  font-family: ${d.headingFont};
  line-height: 1.15;
  margin: 0 0 0.6em;
}

a { color: var(--wf-primary); }

img { max-width: 100%; height: auto; }

:focus-visible {
  outline: 2px solid var(--wf-primary);
  outline-offset: 2px;
}

.wf-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem 1.5rem;
  align-items: center;
  justify-content: space-between;
  padding: 1.1rem clamp(1rem, 4vw, 3rem);
  border-bottom: 1px solid rgba(255,255,255,0.08);
  background: var(--wf-surface);
}

.wf-brand { font-weight: 700; text-decoration: none; color: var(--wf-text); }

.wf-nav nav { display: flex; flex-wrap: wrap; gap: 1rem; }

.wf-nav-link { color: var(--wf-text-muted); text-decoration: none; }
.wf-nav-link.is-active, .wf-nav-link:hover { color: var(--wf-primary); }

main { padding: clamp(1.5rem, 5vw, 4rem) clamp(1rem, 5vw, 4rem); }

.wf-footer {
  padding: 2rem clamp(1rem, 5vw, 4rem);
  border-top: 1px solid rgba(255,255,255,0.08);
  color: var(--wf-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    transition-duration: 0.001ms !important;
  }
}
`;
}

export function toComponentName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  const safe = cleaned.length > 0 ? cleaned : 'Page';
  return /^[0-9]/.test(safe) ? `Page${safe}` : safe;
}

export function escapeText(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
