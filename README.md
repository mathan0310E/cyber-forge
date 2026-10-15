# Wolf Forge

**Your Ideas. Our Forge.**

A free-first, multi-model AI website builder. Describe a website in natural
language and Wolf Forge plans it, generates real source files, installs
dependencies in an isolated sandbox, builds the project, and serves a live,
interactive preview you can keep editing through follow-up instructions — then
export, push to GitHub, or deploy.

Built with a React + Vite frontend, a Node.js/TypeScript API, and an open
architecture for AI providers (OpenRouter first, with optional Gemini and local
Ollama adapters). The default generation path is a **deterministic built-in
engine**, so the whole pipeline works end to end even with no AI provider
configured — no paid API key required by default.

---

## Features

- **Describe → Generate → Preview → Edit → Export → Deploy**
- **Free-first AI engine**
  - Task-aware model routing (planner / generator / ui-refine / debugger / reviewer roles).
  - Server-side free-only enforcement — the backend refuses to dispatch to a
    model whose price cannot be verified as zero. Never silently switches to a
    paid model.
  - Deterministic built-in generator that works with **no AI provider at all**,
    and the same pipeline (plan → files → install → build → preview) powers it.
- **Real previews** — generated projects are built in an isolated worker and
  served from a live preview process behind an access-token proxy, with
  desktop/tablet/mobile viewport controls.
- **Workspace** — AI chat, live preview, file tree + Monaco editor, version
  history with restore, ZIP export, GitHub push, and Vercel deployment.
- **Isolation & security** — generated code is untrusted: builds run in a
  per-job sandbox with resource and network limits, path validation, patch
  safety, secret redaction, and no access to host credentials or other users'
  artifacts.
- **Auth & persistence** — Firebase Authentication / Firestore when configured,
  with a local development driver otherwise. Server-side session verify,
  user-scoped project CRUD, and least-privilege rules.

---

## Repository layout

```text
wolf-forge/
  apps/
    api/          # Express API, build pipeline, AI router, providers, sandbox
    web/          # React + Vite frontend
  packages/
    shared-types/ # Zod schemas + types shared by api and web
  docs/           # setup & configuration documentation
```

## Getting started

### Prerequisites

- Node.js ≥ 20.11 and npm ≥ 9
- (Recommended) Docker for the isolated build sandbox. Without it, the API
  falls back to a reduced-isolation local driver that is **not** suitable for
  untrusted projects — set `SANDBOX_DRIVER=local` only for trusted development
  and keep `SANDBOX_ENABLED` in mind (see below).

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Nothing in `.env` is required to boot. The API starts with local filesystem
persistence, local-signed sessions, and the built-in generation engine. See
`docs/configuration.md` for which variable unlocks which feature.

At minimum, set a real value for:

```bash
# A stable >=32 char secret used to sign local dev sessions.
WOLF_FORGE_LOCAL_AUTH_SECRET=<generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
```

### 3. Run

Start the API and the web app (two terminals, or one with the dev script):

```bash
# API only
npm run dev:api          # http://localhost:3001

# Web app only
npm run dev:web          # http://localhost:5173

# Both
npm run dev
```

Health check: `curl http://localhost:3001/health`

### 4. Verify

```bash
npm run typecheck
npm run build
npm test
```

---

## Connecting an AI provider (optional)

The built-in deterministic engine is always available and requires no keys. To
add real LLM generation:

| Provider | Env variables | Notes |
| --- | --- | --- |
| **OpenRouter** (primary) | `OPENROUTER_API_KEY`, `WOLF_FORGE_FREE_ONLY=true` | Free models only by default; catalog is fetched and eligibility verified server-side. |
| **Gemini** (optional) | `GEMINI_API_KEY`, `GEMINI_FREE_MODELS` | Optional; a Gemini model is never treated as free automatically. |
| **Ollama** (local) | `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_ENABLED=true` | Local inference on your hardware. |

If no eligible free model is available, the API falls back to the built-in
engine and reports the reason honestly in the UI.

---

## The build pipeline

Each build job walks a state machine — Queued → Analyzing → Planning →
Generating → Installing → Building → Repairing → PreviewReady → (Failed /
Cancelled). Progress is streamed to the UI via server-sent events with a
polling fallback.

- **Analyze** parses the natural-language request.
- **Plan** produces a validated (Zod) website specification.
- **Generate** writes actual source files into a new project version.
- **Install & build** run `npm install` and `npm run build` in an isolated,
  time-boxed sandbox with dependency allowlist sanitization.
- **Repair** sends concise diagnostics to the debug model (bounded attempts)
  for a minimal patch, then re-runs the build.
- **Preview** serves the real built output behind an access-token proxy.

Follow-up instructions ("make the nav sticky and turn the accent lime") produce
a *targeted patch* on a new version while preserving the previous working
version for rollback.

---

## Guarantees & honest states

- Build success is only reported after a real exit code 0 and a valid `dist`.
- Preview URLs are only issued after the preview process confirms it is ready.
- GitHub repository creation / push and Vercel deployments are only reported as
  done after the provider confirms them.
- Missing credentials surface as explicit "setup required" states in the UI and
  API, not silent fakes.

---

## Tests

```bash
npm test            # vitest unit tests
npm run test:e2e    # Playwright end-to-end suite
```

Coverage includes AI routing / free-only enforcement, patch validation, sandbox
path-traversal protection, build failure & repair bounds, and the core
sign-in → create → generate → build → preview → refine → export flow.

---

## Deployment integrations

- **GitHub** — OAuth connect, create repository (respecting user visibility),
  commit + push project files, sync subsequent edits. Tokens are encrypted at
  rest and never sent to the browser or generated code.
- **Vercel** — provider-neutral deployment interface: connect, validate build
  output, deploy, and track a real deployment status with a confirmed live URL.

Both show honest setup-required states until their credentials are configured.

---

## License

MIT
