import type {
  AiModel,
  AiProviderId,
  AiTaskRole,
  ModelCapability,
  ModelHealth,
} from '@wolf-forge/shared-types';
import { ApiError } from '../../services/errors.js';
import { logger } from '../../services/logger.js';
import type { ProviderAdapter, ProviderModelInfo } from '../../providers/types.js';

/**
 * Operator-declared role preferences. These are *preferences*, not grants: a
 * model listed here is still rejected at dispatch time if the provider reports
 * it as paid. Order within each role is the fallback order.
 */
export interface RolePreference {
  role: AiTaskRole;
  /** Substrings matched against the model id, in priority order. */
  preferred: string[];
}

export interface RegistryOptions {
  freeOnly: boolean;
  rolePreferences: RolePreference[];
  /** Operator overrides applied after discovery. */
  overrides?: Array<{ id: string; enabled?: boolean; roles?: AiTaskRole[] }>;
  /** Hard cap on models retained from one provider, newest catalogue order first. */
  maxModelsPerProvider?: number;
}

export interface EligibleModel {
  model: AiModel;
  provider: ProviderAdapter;
}

/**
 * The model registry.
 *
 * Responsibilities:
 *  - merge provider-discovered models into one normalised list,
 *  - assign each model the task roles it is allowed to serve,
 *  - compute eligibility from provider metadata (never from a model's name),
 *  - refuse to hand out any model that the free-only policy rejects.
 *
 * The free-only decision is made here and nowhere else, so there is exactly one
 * place to audit.
 */
export class ModelRegistry {
  private models = new Map<string, AiModel>();
  private catalogFetchedAt: string | null = null;
  private catalogSource: 'live' | 'cache' | 'builtin' = 'builtin';
  private providerErrors = new Map<AiProviderId, string>();

  constructor(
    private readonly providers: Map<AiProviderId, ProviderAdapter>,
    private options: RegistryOptions,
  ) {}

  get freeOnly(): boolean {
    return this.options.freeOnly;
  }

  setFreeOnly(value: boolean): void {
    this.options.freeOnly = value;
    this.recomputeBlockedReasons();
  }

  setOverrides(overrides: NonNullable<RegistryOptions['overrides']>): void {
    this.options.overrides = overrides;
    this.applyOverrides();
    this.recomputeBlockedReasons();
  }

  get lastFetch(): { at: string | null; source: 'live' | 'cache' | 'builtin' } {
    return { at: this.catalogFetchedAt, source: this.catalogSource };
  }

  providerError(id: AiProviderId): string | null {
    return this.providerErrors.get(id) ?? null;
  }

  /**
   * Refreshes the catalogue from every configured provider. Provider failures
   * are recorded, not thrown, so one broken provider never blocks the others.
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    let anySucceeded = false;
    const discovered: Array<{ provider: AiProviderId; info: ProviderModelInfo }> = [];
    this.providerErrors.clear();

    for (const [id, adapter] of this.providers) {
      if (!adapter.isConfigured()) {
        this.providerErrors.set(id, adapter.setupHint());
        continue;
      }
      try {
        const models = await adapter.listModels(signal);
        for (const info of models) discovered.push({ provider: id, info });
        anySucceeded = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.providerErrors.set(id, message);
        logger().warn({ provider: id, err: message }, 'model discovery failed');
      }
    }

    const next = new Map<string, AiModel>();
    const perProvider = new Map<AiProviderId, number>();
    const cap = this.options.maxModelsPerProvider ?? 400;

    for (const { provider, info } of discovered) {
      const count = perProvider.get(provider) ?? 0;
      if (count >= cap) continue;
      perProvider.set(provider, count + 1);

      const id = `${provider}:${info.modelId}`;
      const existing = this.models.get(id);
      const roles = this.rolesForModel(info.modelId);
      next.set(id, {
        id,
        provider,
        modelId: info.modelId,
        displayName: info.displayName,
        enabled: existing?.enabled ?? true,
        capabilities: info.capabilities,
        eligibility: info.eligibility,
        contextLength: info.contextLength,
        maxOutputTokens: info.maxOutputTokens,
        roles,
        health: existing?.health ?? 'unknown',
        lastCheckedAt: existing?.lastCheckedAt ?? null,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        failureCount: existing?.failureCount ?? 0,
        timeoutMs: existing?.timeoutMs ?? defaultTimeout(roles),
        promptPricePerMillion: info.promptPricePerMillion,
        completionPricePerMillion: info.completionPricePerMillion,
        blockedReason: null,
        isCustom: false,
      });
    }

    if (anySucceeded) {
      this.models = next;
      this.catalogFetchedAt = new Date().toISOString();
      this.catalogSource = 'live';
    } else if (this.models.size === 0) {
      this.catalogSource = 'builtin';
    }

    this.applyOverrides();
    this.recomputeBlockedReasons();
  }

  /**
   * Registers a model without provider discovery. Used by tests and by
   * operators who need a model the catalogue does not surface.
   */
  upsertModel(model: AiModel): void {
    this.models.set(model.id, model);
    this.recomputeBlockedReasons();
  }

  /** Bulk version of upsertModel, used to re-apply persisted overrides. */
  upsertModelAll(models: AiModel[]): void {
    for (const m of models) {
      this.models.set(m.id, { ...m, blockedReason: null });
    }
    this.recomputeBlockedReasons();
  }

  private rolesForModel(modelId: string): AiTaskRole[] {
    const lower = modelId.toLowerCase();
    const roles = new Set<AiTaskRole>();
    for (const pref of this.options.rolePreferences) {
      if (pref.preferred.some((needle) => lower.includes(needle.toLowerCase()))) {
        roles.add(pref.role);
      }
    }
    if (roles.size === 0) roles.add('fallback');
    return [...roles];
  }

  private applyOverrides(): void {
    for (const override of this.options.overrides ?? []) {
      const model = this.models.get(override.id);
      if (!model) continue;
      if (override.enabled !== undefined) model.enabled = override.enabled;
      if (override.roles && override.roles.length > 0) model.roles = [...override.roles];
    }
  }

  /**
   * Computes `blockedReason` for every model. This is the single source of truth
   * for whether a model may be dispatched to.
   */
  private recomputeBlockedReasons(): void {
    for (const model of this.models.values()) {
      model.blockedReason = this.computeBlockedReason(model);
    }
  }

  private computeBlockedReason(model: AiModel): string | null {
    if (!model.enabled) return 'Disabled by configuration.';

    const adapter = this.providers.get(model.provider);
    if (!adapter || !adapter.isConfigured()) {
      return `${adapter?.label ?? model.provider} is not configured on this server.`;
    }

    if (model.eligibility === 'paid') {
      return `Provider reports a non-zero price ($${model.promptPricePerMillion}/M in, $${model.completionPricePerMillion}/M out). Paid models are never dispatched.`;
    }

    if (this.options.freeOnly && model.eligibility === 'unknown') {
      // Fail closed: unverifiable pricing is treated as unusable rather than
      // silently permitted, which is what "free-only" has to mean.
      return 'Pricing could not be verified, so this model is blocked while free-only mode is on.';
    }

    if (model.health === 'unavailable') {
      return 'The provider recently reported this model as unavailable.';
    }

    return null;
  }

  all(): AiModel[] {
    return [...this.models.values()].sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return a.modelId.localeCompare(b.modelId);
    });
  }

  get(id: string): AiModel | null {
    return this.models.get(id) ?? null;
  }

  /**
   * Returns models eligible for a role, in dispatch order.
   *
   * Ordering: operator-configured preference first, then verified-free before
   * unknown, then healthy before degraded, then larger context first. A model
   * with a `blockedReason` is never returned.
   */
  eligibleForRole(role: AiTaskRole, requiredCapabilities: ModelCapability[] = []): EligibleModel[] {
    const candidates: Array<{ model: AiModel; provider: ProviderAdapter; prefRank: number }> = [];

    for (const model of this.models.values()) {
      if (model.blockedReason) continue;
      if (!model.roles.includes(role) && !model.roles.includes('fallback')) continue;
      if (requiredCapabilities.some((c) => !model.capabilities.includes(c))) continue;
      const provider = this.providers.get(model.provider);
      if (!provider || !provider.isConfigured()) continue;
      candidates.push({ model, provider, prefRank: this.preferenceRank(role, model.modelId) });
    }

    candidates.sort((a, b) => {
      if (a.prefRank !== b.prefRank) return a.prefRank - b.prefRank;
      const elig = (m: AiModel) => (m.eligibility === 'verified-free' ? 0 : 1);
      if (elig(a.model) !== elig(b.model)) return elig(a.model) - elig(b.model);
      const health = (m: AiModel) => (m.health === 'healthy' ? 0 : m.health === 'degraded' ? 1 : 2);
      if (health(a.model) !== health(b.model)) return health(a.model) - health(b.model);
      const ctx = (m: AiModel) => m.contextLength ?? 0;
      if (ctx(a.model) !== ctx(b.model)) return ctx(b.model) - ctx(a.model);
      return a.model.modelId.localeCompare(b.model.modelId);
    });

    return candidates.map(({ model, provider }) => ({ model, provider }));
  }

  private preferenceRank(role: AiTaskRole, modelId: string): number {
    const pref = this.options.rolePreferences.find((p) => p.role === role);
    if (!pref) return 100;
    const lower = modelId.toLowerCase();
    for (let i = 0; i < pref.preferred.length; i += 1) {
      const needle = pref.preferred[i]!;
      if (lower.includes(needle.toLowerCase())) return i;
    }
    return 100;
  }

  /** Throws a typed error describing exactly why no model could be used. */
  requireEligible(role: AiTaskRole, requiredCapabilities: ModelCapability[] = []): EligibleModel {
    const eligible = this.eligibleForRole(role, requiredCapabilities);
    const first = eligible[0];
    if (first) return first;

    const configuredProviders = [...this.providers.values()].filter((p) => p.isConfigured());
    if (configuredProviders.length === 0) {
      throw ApiError.notConfigured(
        'No AI provider is configured. Wolf Forge needs at least one provider to generate websites. ' +
          'Set OPENROUTER_API_KEY in the server environment (free keys work).',
        { providers: [...this.providers.values()].map((p) => ({ id: p.id, hint: p.setupHint() })) },
      );
    }

    const blocked = this.all().filter((m) => m.roles.includes(role) && m.blockedReason);
    if (this.options.freeOnly && blocked.some((m) => m.eligibility === 'unknown')) {
      throw new ApiError(
        'free_only_violation',
        'No model with verifiable zero pricing is available for this task. Free-only mode is on, ' +
          'so Wolf Forge will not fall back to a paid or unverified model. Configure a provider ' +
          'that publishes pricing (OpenRouter), or declare free models explicitly.',
        { status: 503, details: { role, blocked: blocked.slice(0, 10) } },
      );
    }

    throw new ApiError(
      'no_eligible_model',
      `No enabled model is eligible for the "${role}" task. Review the model list in Settings and enable one.`,
      {
        status: 503,
        details: {
          role,
          catalogSource: this.catalogSource,
          candidates: blocked.slice(0, 10).map((m) => ({ id: m.id, reason: m.blockedReason })),
        },
      },
    );
  }

  recordOutcome(
    modelId: string,
    outcome: { ok: boolean; health?: ModelHealth; errorCode?: string | null },
  ): void {
    const model = this.models.get(modelId);
    if (!model) return;
    model.lastCheckedAt = new Date().toISOString();
    if (outcome.ok) {
      model.lastSuccessAt = model.lastCheckedAt;
      model.health = outcome.health ?? 'healthy';
      model.failureCount = 0;
    } else {
      model.failureCount += 1;
      if (outcome.errorCode === 'model_unavailable' || outcome.errorCode === 'unauthorized') {
        model.health = 'unavailable';
      } else if (model.failureCount >= 3) {
        model.health = 'degraded';
      }
    }
    model.blockedReason = this.computeBlockedReason(model);
  }

  /** Snapshot for the settings UI. Never includes credentials. */
  snapshot() {
    return {
      freeOnly: this.options.freeOnly,
      models: this.all(),
      catalogFetchedAt: this.catalogFetchedAt,
      catalogSource: this.catalogSource,
    };
  }
}

function defaultTimeout(roles: AiTaskRole[]): number {
  if (roles.includes('codegen')) return 180_000;
  if (roles.includes('planner')) return 90_000;
  return 60_000;
}
