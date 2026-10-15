import type { FreeEligibility, ModelCapability } from '@wolf-forge/shared-types';
import {
  ProviderError,
  classifyStatus,
  providerFetch,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderModelInfo,
} from '../types.js';
import { logger } from '../../services/logger.js';

interface GeminiModel {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

export interface GeminiOptions {
  apiKey: string;
  /**
   * Explicit operator assertion that these model ids are on a free tier.
   * Gemini's API publishes no pricing, so without this declaration every model
   * is treated as `unknown` and is blocked in strict free-only mode.
   */
  freeModelAllowlist: readonly string[];
}

/**
 * Optional Gemini adapter.
 *
 * Deliberately fails closed: Google's API does not expose per-model pricing, so
 * eligibility cannot be verified the way it can with OpenRouter. A model is only
 * treated as free when an operator explicitly names it in GEMINI_FREE_MODELS.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini';
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(private readonly options: GeminiOptions) {}

  isConfigured(): boolean {
    return this.options.apiKey.length > 0;
  }

  setupHint(): string {
    return this.isConfigured()
      ? this.options.freeModelAllowlist.length > 0
        ? `Connected. ${this.options.freeModelAllowlist.length} model(s) declared free via GEMINI_FREE_MODELS.`
        : 'Connected, but no models are declared free. Gemini publishes no pricing, so set GEMINI_FREE_MODELS to the free-tier models you want to allow.'
      : 'Optional. Set GEMINI_API_KEY to enable Gemini, and declare free-tier models in GEMINI_FREE_MODELS.';
  }

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.options.apiKey, 'Content-Type': 'application/json' };
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModelInfo[]> {
    if (!this.isConfigured()) return [];

    const res = await providerFetch(this.id, `${this.baseUrl}/models?pageSize=200`, {
      method: 'GET',
      headers: this.headers(),
      timeoutMs: 20_000,
      signal,
    });
    if (!res.ok) throw classifyStatus(this.id, res.status, await safeText(res));

    let payload: { models?: GeminiModel[] };
    try {
      payload = (await res.json()) as { models?: GeminiModel[] };
    } catch {
      throw new ProviderError(this.id, 'malformed_response', 'Gemini returned unparseable JSON.');
    }

    const allow = new Set(this.options.freeModelAllowlist);
    return (payload.models ?? [])
      .filter((m) => typeof m.name === 'string')
      .map((m) => {
        // `models/gemini-2.0-flash` -> `gemini-2.0-flash`
        const id = m.name!.replace(/^models\//, '');
        const declaredFree = allow.has(id);
        const capabilities: ModelCapability[] = ['chat'];
        if (m.supportedGenerationMethods?.includes('generateContent')) {
          capabilities.push('json-mode');
        }
        const contextLength = typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : null;
        if (contextLength !== null && contextLength >= 100_000) capabilities.push('long-context');
        const eligibility: FreeEligibility = declaredFree ? 'verified-free' : 'unknown';
        return {
          modelId: id,
          displayName: m.displayName ?? id,
          contextLength,
          maxOutputTokens: typeof m.outputTokenLimit === 'number' ? m.outputTokenLimit : null,
          promptPricePerMillion: null,
          completionPricePerMillion: null,
          capabilities,
          eligibility,
        } satisfies ProviderModelInfo;
      })
      .filter((m) => m.capabilities.includes('json-mode'));
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new ProviderError(
        this.id,
        'unauthorized',
        'Gemini is not configured on this server.',
        undefined,
        false,
      );
    }

    const system = request.messages.filter((m) => m.role === 'system');
    const rest = request.messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      contents: rest.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: request.temperature ?? 0.4,
        ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
      ...(system.length > 0
        ? { systemInstruction: { parts: [{ text: system.map((s) => s.content).join('\n\n') }] } }
        : {}),
    };

    const url = `${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`;
    const res = await providerFetch(this.id, url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });

    const raw = await safeText(res);
    if (!res.ok) throw classifyStatus(this.id, res.status, raw);

    let parsed: GeminiResponse;
    try {
      parsed = JSON.parse(raw) as GeminiResponse;
    } catch {
      throw new ProviderError(this.id, 'malformed_response', 'Gemini returned a body that was not JSON.');
    }

    const blockReason = parsed.promptFeedback?.blockReason;
    const text = (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');

    if (!text) {
      throw new ProviderError(
        this.id,
        blockReason ? 'bad_request' : 'malformed_response',
        blockReason
          ? `Gemini declined the request (${blockReason}).`
          : 'Gemini returned an empty completion.',
        undefined,
        !blockReason,
      );
    }

    return {
      text,
      model: request.model,
      provider: this.id,
      usage: {
        promptTokens: parsed.usageMetadata?.promptTokenCount ?? null,
        completionTokens: parsed.usageMetadata?.candidatesTokenCount ?? null,
        // Gemini does not return cost; reporting one would be fabrication.
        costUsd: null,
      },
      providerRequestId: null,
      finishReason: parsed.candidates?.[0]?.finishReason ?? null,
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return { ok: false, message: this.setupHint(), latencyMs: null, sampleModels: [] };
    }
    const started = Date.now();
    try {
      const models = await this.listModels(signal);
      const latencyMs = Date.now() - started;
      const free = models.filter((m) => m.eligibility === 'verified-free');
      logger().info({ total: models.length, declaredFree: free.length }, 'gemini models listed');
      return {
        ok: models.length > 0,
        message:
          models.length === 0
            ? 'The API key was accepted but no usable models were returned.'
            : `Key accepted. ${models.length} models visible, ${free.length} declared free by the operator.`,
        latencyMs,
        sampleModels: free.slice(0, 8).map((m) => m.modelId),
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof ProviderError ? e.message : `Gemini probe failed: ${String(e)}`,
        latencyMs: Date.now() - started,
        sampleModels: [],
      };
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
