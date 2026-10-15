# Configuration

Copy `.env.example` to `.env` and set only the variables you need. **Nothing is
required to boot the core application.** Every external integration degrades to
an honest "setup required" state in the UI when its credentials are missing.

## Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment. Production refuses the local auth driver unless explicitly allowed. |
| `PORT` | `3001` | API listen port. |
| `WEB_ORIGIN` | `http://localhost:5173` | Allowed browser origins (comma-separated) for CORS. |

## Persistence

| Variable | Default | Purpose |
| --- | --- | --- |
| `WOLF_FORGE_DATA_DRIVER` | `auto` | `auto` → Firestore when Firebase credentials exist, else local filesystem. `firestore` → require Firebase and fail fast. `local` → always the filesystem driver (`.data/`). |
| `ARTIFACT_STORAGE_PATH` | `.artifacts` | Where generated project source trees and build artifacts are stored. Per-project, per-version directories. |

## Authentication

| Variable | Default | Purpose |
| --- | --- | --- |
| `WOLF_FORGE_AUTH_DRIVER` | `auto` | `auto` → Firebase when configured, else local. `firebase` → require Firebase. `local` → local signed sessions (development only). |
| `WOLF_FORGE_LOCAL_AUTH_SECRET` | — | **Required for the local driver** — ≥32 char secret used to sign session tokens. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. A stable secret keeps sessions valid across restarts. |
| `WOLF_FORGE_ALLOW_LOCAL_AUTH_IN_PROD` | `0` | Set to `1` only if you understand the risk of local dev auth in production. |

### Firebase (server-side Admin SDK)

| Variable | Purpose |
| --- | --- |
| `FIREBASE_PROJECT_ID` | Firebase project id. |
| `FIREBASE_CLIENT_EMAIL` | Service account client email. |
| `FIREBASE_PRIVATE_KEY` | Service account private key (escape newlines as `\n` on a single line). |
| `GOOGLE_APPLICATION_CREDENTIALS` | Alternative: path to a service account JSON file (Application Default Credentials). |

### Firebase (web client)

`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`,
`VITE_FIREBASE_APP_ID` — the non-secret browser-side Firebase config, wired to
the frontend auth forms. Not required for the local auth driver.

## AI providers

### OpenRouter (primary, free-first)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | Server-side key; never sent to the browser. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | API base URL. |
| `WOLF_FORGE_FREE_ONLY` | `true` | When true the backend refuses to dispatch to any model whose price is not verified as zero. Enforced in code, not in the UI. |
| `OPENROUTER_SITE_URL` | `http://localhost:5173` | Attribution URLs sent to OpenRouter. |
| `OPENROUTER_APP_TITLE` | `Wolf Forge` | Attribution app title. |
| `OPENROUTER_CATALOG_TTL_MS` | `900000` | How long to cache the model catalog. |

### Gemini (optional)

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Server-side key. |
| `GEMINI_FREE_MODELS` | Comma-separated allowlist. A Gemini model is never treated as free by default. |

### Ollama (optional, local)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local inference base URL. Restricted to safe destinations server-side (no arbitrary remote endpoints). |
| `OLLAMA_MODEL` | — | Model name to use. |
| `OLLAMA_ENABLED` | `false` | Set `true` to enable the adapter. |

## Sandbox / build worker

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANDBOX_ENABLED` | `true` | Master switch for sandboxed builds. |
| `SANDBOX_DRIVER` | `auto` | `docker` uses the Docker driver; `local` uses reduced isolation (development only). |
| `SANDBOX_IMAGE` | `node:20-alpine` | Base image for build workers. |
| `SANDBOX_BUILD_TIMEOUT_MS` | `300000` | Build step timeout. |
| `SANDBOX_INSTALL_TIMEOUT_MS` | `300000` | Dependency install timeout. |
| `SANDBOX_MEMORY_MB` | `1024` | Container memory limit. |
| `SANDBOX_CPUS` | `1` | CPU limit. |
| `SANDBOX_PIDS_LIMIT` | `256` | Process count limit. |
| `SANDBOX_ALLOW_NETWORK` | `true` | Allow dependency install to reach the network. |
| `SANDBOX_PREVIEW_PORT_RANGE_START` / `_END` | `4100`–`4300` | Host port range for preview containers. |

## Integrations

### GitHub

| Variable | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client id. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret. |
| `GITHUB_OAUTH_CALLBACK_URL` | Public callback URL (must match the OAuth App). |
| `INTEGRATION_ENCRYPTION_KEY` | 32-byte base64 key for encrypting tokens at rest. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. |

### Deployment

| Variable | Purpose |
| --- | --- |
| `DEPLOYMENT_PROVIDER` | `vercel` is the implemented provider; empty disables deployment. |
| `DEPLOYMENT_API_TOKEN` | Vercel API token. |

### Admin

| Variable | Purpose |
| --- | --- |
| `WOLF_FORGE_ADMIN_UIDS` | Comma-separated UIDs allowed to reach admin-only endpoints. Admin is never granted from a user-editable field. |

## Quotas

Per-user, server-side enforced. See `QUOTA_*` in `.env.example` for the full
list (concurrent builds, repair attempts, build duration, prompt length, file
count, source bytes, output tokens, daily builds, requests per minute).

## Which "blank" features are expected when unconfigured

- No `OPENROUTER_API_KEY` → model catalog stays empty and the deterministic
  built-in generator runs instead; the model page explains the missing key.
- No Firebase credentials → local auth + local persistence; the FIREBASE_*
  fields are ignored until configured.
- No `GITHUB_CLIENT_ID`/`SECRET` → GitHub connect shows a setup-required state;
  ZIP export still works.
- No `DEPLOYMENT_PROVIDER`/token → the deploy action shows a setup-required
  state; local preview, export, GitHub push still work.
- Docker missing → sandbox falls back to reduced-isolation local driver and
  logs a warning that it is not suitable for untrusted projects.