import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : def;
    });

const str = (def = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v));

const required = (name: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined))
    .refine((v) => v !== undefined, { message: `${name} is required` });

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3101),
  WEB_ORIGIN: str('http://localhost:5173'),

  WOLF_FORGE_DATA_DRIVER: z.enum(['auto', 'firestore', 'local']).default('auto'),
  WOLF_FORGE_AUTH_DRIVER: z.enum(['auto', 'firebase', 'local']).default('auto'),
  WOLF_FORGE_LOCAL_AUTH_SECRET: str(''),
  WOLF_FORGE_ALLOW_LOCAL_AUTH_IN_PROD: bool(false),

  FIREBASE_PROJECT_ID: str(''),
  FIREBASE_CLIENT_EMAIL: str(''),
  FIREBASE_PRIVATE_KEY: str(''),
  GOOGLE_APPLICATION_CREDENTIALS: str(''),

  OPENROUTER_API_KEY: str(''),
  OPENROUTER_BASE_URL: str('https://openrouter.ai/api/v1'),
  OPENROUTER_SITE_URL: str('http://localhost:5173'),
  OPENROUTER_APP_TITLE: str('Wolf Forge'),
  OPENROUTER_CATALOG_TTL_MS: int(900_000),
  WOLF_FORGE_FREE_ONLY: bool(true),

  GEMINI_API_KEY: str(''),
  GEMINI_FREE_MODELS: str(''),

  OLLAMA_BASE_URL: str('http://127.0.0.1:11434'),
  OLLAMA_MODEL: str(''),
  OLLAMA_ENABLED: bool(false),

  SANDBOX_ENABLED: bool(true),
  SANDBOX_DRIVER: z.enum(['auto', 'docker', 'local']).default('auto'),
  SANDBOX_IMAGE: str('node:20-alpine'),
  SANDBOX_BUILD_TIMEOUT_MS: int(300_000),
  SANDBOX_INSTALL_TIMEOUT_MS: int(300_000),
  SANDBOX_MEMORY_MB: int(1024),
  SANDBOX_CPUS: int(1),
  SANDBOX_PIDS_LIMIT: int(256),
  SANDBOX_ALLOW_NETWORK: bool(true),
  SANDBOX_PREVIEW_PORT_RANGE_START: int(4100),
  SANDBOX_PREVIEW_PORT_RANGE_END: int(4300),

  ARTIFACT_STORAGE_PATH: str('.artifacts'),

  GITHUB_CLIENT_ID: str(''),
  GITHUB_CLIENT_SECRET: str(''),
  GITHUB_OAUTH_CALLBACK_URL: str('http://localhost:3101/api/v1/integrations/github/callback'),
  INTEGRATION_ENCRYPTION_KEY: str(''),

  VERCEL_CLIENT_ID: str(''),
  VERCEL_CLIENT_SECRET: str(''),
  VERCEL_OAUTH_CALLBACK_URL: str('http://localhost:3101/api/v1/integrations/vercel/callback'),

  WOLF_FORGE_ADMIN_UIDS: str(''),

  DEPLOYMENT_PROVIDER: str(''),
  DEPLOYMENT_API_TOKEN: str(''),
  DEPLOYMENT_VERCEL_TEAM_ID: str(''),
  DEPLOYMENT_VERCEL_PROJECT_ID: str(''),

  QUOTA_MAX_CONCURRENT_BUILDS: int(1),
  QUOTA_MAX_REPAIR_ATTEMPTS: int(2),
  QUOTA_MAX_BUILD_DURATION_MS: int(900_000),
  QUOTA_MAX_PROMPT_CHARS: int(8_000),
  QUOTA_MAX_FILES_PER_PROJECT: int(120),
  QUOTA_MAX_SOURCE_BYTES: int(2_000_000),
  QUOTA_MAX_OUTPUT_TOKENS: int(8_192),
  QUOTA_DAILY_BUILDS: int(25),
  QUOTA_REQUESTS_PER_MINUTE: int(60),
});

export type Env = z.infer<typeof EnvSchema>;

export const ConfigSchema = EnvSchema.transform((env) => ({
  env,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  webOrigins: env.WEB_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  firebase: {
    configured: Boolean(
      (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) ||
        env.GOOGLE_APPLICATION_CREDENTIALS,
    ),
  },
  openrouter: {
    configured: env.OPENROUTER_API_KEY.length > 0,
    baseUrl: env.OPENROUTER_BASE_URL.replace(/\/+$/, ''),
  },
  gemini: {
    configured: env.GEMINI_API_KEY.length > 0,
    allowlist: env.GEMINI_FREE_MODELS.split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  },
  ollama: {
    configured: env.OLLAMA_ENABLED && env.OLLAMA_MODEL.length > 0,
    baseUrl: env.OLLAMA_BASE_URL.replace(/\/+$/, ''),
    model: env.OLLAMA_MODEL,
  },
  github: {
    oauthConfigured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    encryptionConfigured: env.INTEGRATION_ENCRYPTION_KEY.length >= 32,
  },
  vercelOAuth: {
    oauthConfigured: Boolean(env.VERCEL_CLIENT_ID && env.VERCEL_CLIENT_SECRET),
    encryptionConfigured: env.INTEGRATION_ENCRYPTION_KEY.length >= 32,
    callbackUrl: env.VERCEL_OAUTH_CALLBACK_URL,
    clientId: env.VERCEL_CLIENT_ID,
    clientSecret: env.VERCEL_CLIENT_SECRET,
  },
  deployment: {
    provider: env.DEPLOYMENT_PROVIDER,
    configured: Boolean(env.DEPLOYMENT_PROVIDER && env.DEPLOYMENT_API_TOKEN),
  },
  quotas: {
    maxConcurrentBuilds: env.QUOTA_MAX_CONCURRENT_BUILDS,
    maxRepairAttempts: env.QUOTA_MAX_REPAIR_ATTEMPTS,
    maxBuildDurationMs: env.QUOTA_MAX_BUILD_DURATION_MS,
    maxPromptChars: env.QUOTA_MAX_PROMPT_CHARS,
    maxFilesPerProject: env.QUOTA_MAX_FILES_PER_PROJECT,
    maxSourceBytes: env.QUOTA_MAX_SOURCE_BYTES,
    maxOutputTokens: env.QUOTA_MAX_OUTPUT_TOKENS,
    dailyBuilds: env.QUOTA_DAILY_BUILDS,
    requestsPerMinute: env.QUOTA_REQUESTS_PER_MINUTE,
  },
  freeOnly: env.WOLF_FORGE_FREE_ONLY,
}));

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export { required };
