import type { ModelCapability } from '@wolf-forge/shared-types';
import {
  ProviderError,
  classifyStatus,
  deriveEligibility,
  parsePrice,
  providerFetch,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderModelInfo,
} from '../types.js';
import { logger } from '../../services/logger.js';
import { redact } from '../../services/redact.js';

interface OpenRouterModel {
  id?: string;
  name?: string;
  context_length?: number | null;
  pricing?: Record<string, unknown> | null;
  supported_parameters?: string[] | null;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] } | null;
}

interface OpenRouterChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Present on some responses when the account has credit reporting enabled. */
    total_cost?: number;
  };
  error?: { message?: string; code?: number | string; metadata?: unknown };
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl: string;
  siteUrl: string;
  appTitle: string;
  catalogTtlMs: number;
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly id = 'openrouter' as const;
  readonly label = 'OpenRouter';

  private cache: { at: number; models: ProviderModelInfo[] } | null = null;

  constructor(private readonly options: OpenRouterOptions) {}

  isConfigured(): boolean {
    return this.options.apiKey.length > 0;
  }

  setupHint(): string {
    return this.isConfigured()
      ? 'Connected. Free-only policy is enforced by the server.'
      : 'Set OPENROUTER_API_KEY in the server environment. Create a free key at https://openrouter.ai/keys. No payment method is required for :free models.';
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
      // OpenRouter uses these for attribution; they are not secrets.
      'HTTP-Referer': this.options.siteUrl,
      'X-Title': this.options.appTitle,
    };
  }

  /**
   * Fetches the live catalogue. Prices arrive as decimal strings, e.g. "0" or
   * "0.0000008"; we convert to USD per million tokens.
   */
  async listModels(signal?: AbortSignal): Promise<ProviderModelInfo[]> {
    if (!this.isConfigured()) return [];
    if (this.cache && Date.now() - this.cache.at < this.options.catalogTtlMs) {
      return this.cache.models;
    }

    const res = await providerFetch(this.id, `${this.options.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers(),
      timeoutMs: 20_000,
      signal,
    });

    if (!res.ok) {
      const body = await safeText(res);
      throw classifyStatus(this.id, res.status, body);
    }

    let payload: { data?: OpenRouterModel[] };
    try {
      payload = (await res.json()) as { data?: OpenRouterModel[] };
    } catch {
      throw new ProviderError(this.id, 'malformed_response', 'OpenRouter returned unparseable JSON.');
    }

    const models = (payload.data ?? [])
      .map((m) => this.toModelInfo(m))
      .filter((m): m is ProviderModelInfo => m !== null);

    this.cache = { at: Date.now(), models };
    const freeCount = models.filter((m) => m.eligibility === 'verified-free').length;
    logger().info({ total: models.length, free: freeCount }, 'openrouter catalogue fetched');
    return models;
  }

  private toModelInfo(m: OpenRouterModel): ProviderModelInfo | null {
    if (!m.id || typeof m.id !== 'string') return null;
    const promptPerToken = parsePrice(m.pricing?.prompt);
    const completionPerToken = parsePrice(m.pricing?.completion);
    // OpenRouter prices are USD per token; the UI reports per million.
    const promptPerMillion =
      promptPerToken === null ? null : Number((promptPerToken * 1_000_000).toPrecision(12));
    const completionPerMillion =
      completionPerToken === null ? null : Number((completionPerToken * 1_000_000).toPrecision(12));

    const params = new Set(m.supported_parameters ?? []);
    const capabilities: ModelCapability[] = ['chat'];
    if (params.has('response_format') || params.has('structured_outputs')) {
      capabilities.push('json-mode');
    }
    if (params.has('tools')) capabilities.push('tool-calling');
    const contextLength = typeof m.context_length === 'number' ? m.context_length : null;
    if (contextLength !== null && contextLength >= 100_000) capabilities.push('long-context');

    return {
      modelId: m.id,
      displayName: m.name ?? m.id,
      contextLength,
      maxOutputTokens: null,
      promptPricePerMillion: promptPerMillion,
      completionPricePerMillion: completionPerMillion,
      capabilities,
      eligibility: deriveEligibility(promptPerMillion, completionPerMillion),
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new ProviderError(
        this.id,
        'unauthorized',
        'OpenRouter is not configured on this server.',
        undefined,
        false,
      );
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.4,
      usage: { include: true },
    };
    if (request.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await providerFetch(this.id, `${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });

    const raw = await safeText(res);
    if (!res.ok) {
      const err = classifyStatus(this.id, res.status, raw);
      throw err;
    }

    let parsed: OpenRouterChatResponse;
    try {
      parsed = JSON.parse(raw) as OpenRouterChatResponse;
    } catch {
      throw new ProviderError(
        this.id,
        'malformed_response',
        'OpenRouter returned a body that was not JSON.',
      );
    }

    // OpenRouter can return HTTP 200 with an embedded error object.
    if (parsed.error) {
      const code = typeof parsed.error.code === 'number' ? parsed.error.code : undefined;
      const message = redact(parsed.error.message ?? 'OpenRouter reported an error');
      throw new ProviderError(
        this.id,
        code === 429 ? 'rate_limited' : 'unknown',
        message,
        code,
        code === 429 || (code !== undefined && code >= 500),
        parsed.id ?? null,
      );
    }

    const text = parsed.choices?.[0]?.message?.content ?? '';
    if (typeof text !== 'string' || text.length === 0) {
      throw new ProviderError(
        this.id,
        'malformed_response',
        'OpenRouter returned an empty completion.',
        undefined,
        true,
        parsed.id ?? null,
      );
    }

    const promptTokens = parsed.usage?.prompt_tokens ?? null;
    const completionTokens = parsed.usage?.completion_tokens ?? null;
    // Only report cost when the provider actually returned it.
    const costUsd = typeof parsed.usage?.total_cost === 'number' ? parsed.usage.total_cost : null;

    return {
      text,
      model: parsed.model ?? request.model,
      provider: this.id,
      usage: { promptTokens, completionTokens, costUsd },
      providerRequestId: parsed.id ?? null,
      finishReason: parsed.choices?.[0]?.finish_reason ?? null,
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        message: this.setupHint(),
        latencyMs: null,
        sampleModels: [],
      };
    }
    const started = Date.now();
    try {
      const res = await providerFetch(this.id, `${this.options.baseUrl}/key`, {
        method: 'GET',
        headers: this.headers(),
        timeoutMs: 15_000,
        signal,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const body = await safeText(res);
        const err = classifyStatus(this.id, res.status, body);
        return { ok: false, message: err.message, latencyMs, sampleModels: [] };
      }
      const models = await this.listModels(signal);
      const free = models.filter((m) => m.eligibility === 'verified-free');
      return {
        ok: true,
        message: `Key accepted. ${models.length} models visible, ${free.length} verified free.`,
        latencyMs,
        sampleModels: free.slice(0, 8).map((m) => m.modelId),
      };
    } catch (e) {
      const latencyMs = Date.now() - started;
      const message =
        e instanceof ProviderError ? e.message : `OpenRouter probe failed: ${String(e)}`;
      return { ok: false, message, latencyMs, sampleModels: [] };
    }
  }

  /** Test helper: drops cached catalogue metadata. */
  clearCache(): void {
    this.cache = null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
