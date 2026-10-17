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
  // Best-in-class FREE picks per task (Oct 2026, verified via live catalogue):
  //  - planner/review: long-reasoning orchestrators with 1M context.
  //  - codegen/ui-refine/debug: agentic coding specialists + fast throughput.
  // Substrings match against the full OpenRouter model id; order = priority.
  {
    role: 'planner',
    preferred: ['nemotron-3-ultra', 'nemotron-3-super', 'inkling', 'gemma-4', 'laguna-s-2.1', 'gemini', 'llama', 'qwen', 'mistral', 'deepseek'],
  },
  {
    role: 'codegen',
    preferred: ['laguna-s-2.1', 'laguna-xs-2.1', 'north-mini-code', 'nemotron-3.5-lightning', 'nemotron-3-super', 'llama', 'qwen', 'mistral', 'codestral', 'deepseek'],
  },
  {
    role: 'ui-refine',
    preferred: ['laguna-s-2.1', 'gemma-4', 'nemotron-3.5-lightning', 'inkling', 'llama', 'gemini', 'qwen', 'mistral'],
  },
  {
    role: 'debug',
    preferred: ['laguna-s-2.1', 'north-mini-code', 'nemotron-3-nano', 'llama', 'nemotron', 'deepseek', 'qwen'],
  },
  {
    role: 'review',
    preferred: ['nemotron-3-ultra', 'gemma-4', 'laguna-s-2.1', 'gemini', 'llama', 'mistral'],
  },
  {
    role: 'fallback',
    preferred: ['openrouter/free'],
  },
];

let singleton: AiServices | undefined;

/**
 * Declared-free OpenRouter models, pinned per task role (Oct 2026 snapshot).
 * Used ONLY when live catalogue discovery returns nothing (bad/expired key,
 * network outage). Every `:free`-suffixed OpenRouter endpoint bills $0, so
 * these register as `verified-free` and remain dispatchable in free-only
 * mode. The next successful live refresh replaces them with priced entries;
 * anything the provider reports as paid is never dispatched. Poolside :free
 * endpoints are scheduled to expire 31 Oct 2026 — the Nemotron/Gemma entries
 * are the longer-lived backups.
 */
const DECLARED_FREE_MODELS: Array<{
  modelId: string;
  displayName: string;
  contextLength: number;
  roles: AiTaskRole[];
}> = [
  // --- codegen: agentic coding specialists (Terminal-Bench grade) ---------
  {
    modelId: 'poolside/laguna-s-2.1:free',
    displayName: 'Poolside Laguna S 2.1 (free)',
    contextLength: 262_144,
    roles: ['codegen', 'ui-refine', 'debug', 'fallback'],
  },
  {
    modelId: 'poolside/laguna-xs-2.1:free',
    displayName: 'Poolside Laguna XS 2.1 (free)',
    contextLength: 262_144,
    roles: ['codegen', 'fallback'],
  },
  {
    modelId: 'cohere/north-mini-code:free',
    displayName: 'Cohere North Mini Code (free)',
    contextLength: 256_000,
    roles: ['codegen', 'debug', 'fallback'],
  },
  // --- planner/review: 1M-ctx reasoning orchestrators ----------------------
  {
    modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    displayName: 'NVIDIA Nemotron 3 Ultra (free)',
    contextLength: 1_000_000,
    roles: ['planner', 'review', 'fallback'],
  },
  {
    modelId: 'nvidia/nemotron-3-super-120b-a12b:free',
    displayName: 'NVIDIA Nemotron 3 Super (free)',
    contextLength: 262_144,
    roles: ['planner', 'codegen', 'review', 'fallback'],
  },
  {
    modelId: 'thinkingmachines/inkling:free',
    displayName: 'Thinking Machines Inkling (free)',
    contextLength: 1_048_576,
    roles: ['planner', 'ui-refine', 'review', 'fallback'],
  },
  // --- fast throughput / general backup -----------------------------------
  {
    modelId: 'nvidia/nemotron-3.5-lightning:free',
    displayName: 'NVIDIA Nemotron 3.5 Lightning (free)',
    contextLength: 1_000_000,
    roles: ['codegen', 'ui-refine', 'debug', 'fallback'],
  },
  {
    modelId: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    displayName: 'NVIDIA Nemotron 3 Nano Omni Reasoning (free)',
    contextLength: 256_000,
    roles: ['debug', 'fallback'],
  },
  {
    modelId: 'google/gemma-4-31b-it:free',
    displayName: 'Google Gemma 4 31B IT (free)',
    contextLength: 262_144,
    roles: ['planner', 'ui-refine', 'review', 'fallback'],
  },
  {
    modelId: 'google/gemma-4-26b-a4b-it:free',
    displayName: 'Google Gemma 4 26B IT (free)',
    contextLength: 262_144,
    roles: ['planner', 'review', 'fallback'],
  },
  {
    modelId: 'openrouter/free',
    displayName: 'OpenRouter auto-router (free)',
    contextLength: 200_000,
    roles: ['fallback'],
  },
];

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

  // Fallback catalogue: if live discovery returned nothing (bad/missing key,
  // outage), register the declared-free list so every role has a dispatchable
  // model. These are `:free`-suffixed endpoints ($0 by construction) so they
  // register as verified-free and remain dispatchable in free-only mode. The
  // next successful live refresh replaces them with priced entries; anything
  // the provider reports as paid is never dispatched.
  if (registry.all().length === 0) {
    for (const declared of DECLARED_FREE_MODELS) {
      registry.upsertModel({
        id: `openrouter:${declared.modelId}`,
        provider: 'openrouter',
        modelId: declared.modelId,
        displayName: declared.displayName,
        enabled: true,
        capabilities: ['chat', 'json-mode', 'long-context'],
        eligibility: 'verified-free',
        contextLength: declared.contextLength,
        maxOutputTokens: null,
        roles: declared.roles,
        health: 'unknown',
        lastCheckedAt: null,
        lastSuccessAt: null,
        failureCount: 0,
        timeoutMs: declared.roles.includes('codegen') ? 180_000 : 90_000,
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
        blockedReason: null,
        isCustom: true,
      });
    }
    logger().warn(
      { models: DECLARED_FREE_MODELS.length },
      'live catalogue empty — registered declared-free fallback list (every role has a dispatchable :free model)',
    );
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