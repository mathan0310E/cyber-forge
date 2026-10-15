import type {
  AiConfig,
  AiModel,
  AiProviderId,
  AiRoleAssignment,
  AiTaskRole,
  ProviderTestResult,
} from '@wolf-forge/shared-types';
import type { Config } from '../config/env.js';
import type { DocStore } from '../db/store.js';
import { COLLECTIONS } from '../db/store.js';
import { logger } from '../services/logger.js';
import { OpenRouterAdapter } from '../providers/openrouter/adapter.js';
import { GeminiAdapter } from '../providers/gemini/adapter.js';
import { OllamaAdapter } from '../providers/ollama/adapter.js';
import type { ProviderAdapter } from '../providers/types.js';
import { ModelRegistry, type RolePreference } from '../ai/router/registry.js';
import { ModelRouter } from '../ai/router/router.js';
import type { AiDispatchRecord } from '@wolf-forge/shared-types';
import { ApiError } from '../services/errors.js';

/**
 * Builds the provider set from configuration and exposes the registry + router
 * singleton that the whole API shares.
 *
 * Configuration comes from environment variables (see `config/env.ts`) and is
 * *not* user-editable. Operator overrides (enable/disable, role assignment) are
 * persisted in Firestore/local store so the settings UI can adjust them, but
 * free-only enforcement always comes from the server environment.
 */
export interface AiServices {
  providers: Map<AiProviderId, ProviderAdapter>;
  registry: ModelRegistry;
  router: ModelRouter;
  persistDispatch: (record: AiDispatchRecord) => Promise<void>;
}

const ROLE_PREFERENCES: RolePreference[] = [
  {
    role: 'planner',
    preferred: ['gemini', 'llama', 'nemotron', 'qwen', 'mistral', 'deepseek'],
  },
  {
    role: 'codegen',
    preferred: ['llama', 'nemotron', 'qwen', 'mistral', 'codestral', 'deepseek'],
  },
  {
    role: 'ui-refine',
    preferred: ['llama', 'nemotron', 'gemini', 'qwen', 'mistral'],
  },
  {
    role: 'debug',
    preferred: ['llama', 'nemotron', 'deepseek', 'qwen'],
  },
  {
    role: 'review',
    preferred: ['gemini', 'llama', 'nemotron', 'mistral'],
  },
  {
    role: 'fallback',
    preferred: [],
  },
];

let singleton: AiServices | undefined;

/**
 * Loads previously-saved operator overrides (enabled flags and role sets) from
 * the store so the settings UI can adjust them.
 */
async function loadOverrides(store: DocStore): Promise<AiModel[] | null> {
  const saved = await store.get<{ models: AiModel[] }>(COLLECTIONS.aiConfig, 'registry');
  const raw = saved as { models?: AiModel[] } | null;
  return Array.isArray(raw?.models) ? raw.models : null;
}

export async function initAiServices(config: Config, store: DocStore): Promise<AiServices> {
  if (singleton) return singleton;

  const providers = new Map<AiProviderId, ProviderAdapter>();
  providers.set(
    'openrouter',
    new OpenRouterAdapter({
      apiKey: config.env.OPENROUTER_API_KEY,
      baseUrl: config.openrouter.baseUrl,
      siteUrl: config.env.OPENROUTER_SITE_URL,
      appTitle: config.env.OPENROUTER_APP_TITLE,
      catalogTtlMs: config.env.OPENROUTER_CATALOG_TTL_MS,
    }),
  );
  if (config.gemini.configured) {
    providers.set(
      'gemini',
      new GeminiAdapter({
        apiKey: config.env.GEMINI_API_KEY,
        freeModelAllowlist: config.gemini.allowlist,
      }),
    );
  }
  if (config.ollama.configured) {
    providers.set(
      'ollama',
      new OllamaAdapter({
        baseUrl: config.env.OLLAMA_BASE_URL,
        model: config.env.OLLAMA_MODEL,
        enabled: config.env.OLLAMA_ENABLED,
      }),
    );
  }

  const registry = new ModelRegistry(providers, {
    freeOnly: config.freeOnly,
    rolePreferences: ROLE_PREFERENCES,
  });

  // Apply persisted operator overrides before the first refresh.
  const savedOverrides = await loadOverrides(store);
  if (savedOverrides) {
    registry.upsertModelAll(savedOverrides);
  }

  const persistDispatch = async (record: AiDispatchRecord) => {
    await store.set(COLLECTIONS.usage, record.id, record);
  };

  const router = new ModelRouter(registry, persistDispatch);

  const services: AiServices = { providers, registry, router, persistDispatch };
  // Lazy first refresh: do a non-blocking refresh to warm the catalogue.
  try {
    await registry.refresh();
    logger().info(
      {
        models: registry.all().length,
        free: registry.all().filter((m) => m.eligibility === 'verified-free').length,
        source: registry.lastFetch.source,
      },
      'AI model catalogue initialised',
    );
  } catch (e) {
    logger().warn({ err: String(e) }, 'initial AI catalogue refresh failed (will retry)');
  }

  singleton = services;
  return services;
}

export function getAiServices(): AiServices {
  if (!singleton) throw new Error('AI services accessed before initAiServices()');
  return singleton;
}

/**
 * Builds the config payload the settings UI renders. Never includes keys.
 */
export async function buildAiConfigSnapshot(
  services: AiServices,
): Promise<AiConfig> {
  const providers = [...services.providers.values()];
  const modelList = services.registry.all();
  const providerStatus = providers.map((p) => {
    const configured = p.isConfigured();
    const registryError = services.registry.providerError(p.id);
    return {
      id: p.id,
      label: p.label,
      configured,
      enabled: configured,
      setupHint: p.setupHint(),
      health: (configured ? 'unknown' : 'unavailable') as AiModel['health'],
      lastCheckedAt: null,
      detail: registryError ? registryError.slice(0, 300) : null,
    };
  });

  // Derive role assignments from the registry's current model roles.
  const roles: AiTaskRole[] = ['planner', 'codegen', 'ui-refine', 'debug', 'review', 'fallback'];
  const assignments: AiRoleAssignment[] = roles.map((role) => {
    const ordered = modelList
      .filter((m) => m.roles.includes(role) && m.enabled)
      .sort((a, b) => rankOf(role, a).localeCompare(rankOf(role, b)))
      .map((m) => m.id)
      .slice(0, 8);
    return { role, modelIds: ordered };
  });

  return {
    freeOnly: services.registry.freeOnly,
    providers: providerStatus,
    assignments,
    models: modelList,
    catalogFetchedAt: services.registry.lastFetch.at,
    catalogSource: services.registry.lastFetch.source,
  };
}

function rankOf(role: AiTaskRole, model: AiModel): string {
  return role in model.roles ? '0' : '1';
}

/** Runs a live connectivity probe against one provider. */
export async function testProvider(
  services: AiServices,
  providerId: AiProviderId,
): Promise<ProviderTestResult> {
  const adapter = services.providers.get(providerId);
  if (!adapter) {
    throw ApiError.notFound('Unknown provider');
  }
  const health = await adapter.healthCheck();
  return {
    provider: providerId,
    ok: health.ok,
    message: health.message.slice(0, 600),
    latencyMs: health.latencyMs,
    sampleModels: health.sampleModels,
    checkedAt: new Date().toISOString(),
  };
}

export async function saveAiConfig(
  store: DocStore,
  patch: { freeOnly?: boolean; modelOverrides?: Array<{ id: string; enabled?: boolean; roles?: AiTaskRole[] }> },
): Promise<void> {
  const existing = await store.get<{ models: AiModel[] }>(COLLECTIONS.aiConfig, 'registry');
  const models = existing?.models ?? [];
  for (const override of patch.modelOverrides ?? []) {
    const model = models.find((m) => m.id === override.id);
    if (!model) continue;
    if (override.enabled !== undefined) model.enabled = override.enabled;
    if (override.roles) model.roles = [...override.roles];
  }
  await store.set(COLLECTIONS.aiConfig, 'registry', { models });
}