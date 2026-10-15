import type { AiProviderId, FreeEligibility, ModelCapability } from '@wolf-forge/shared-types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** Ask the provider for a JSON object response where supported. */
  jsonMode?: boolean;
  /** Aborts the in-flight request. Always wired to build cancellation. */
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Null unless the provider reported a price we can trust. */
  costUsd: number | null;
}

export interface ChatResponse {
  text: string;
  model: string;
  provider: AiProviderId;
  usage: ChatUsage;
  providerRequestId: string | null;
  finishReason: string | null;
}

/** What a provider tells us about one of its models. */
export interface ProviderModelInfo {
  modelId: string;
  displayName: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
  promptPricePerMillion: number | null;
  completionPricePerMillion: number | null;
  capabilities: ModelCapability[];
  eligibility: FreeEligibility;
}

export interface ProviderHealth {
  ok: boolean;
  message: string;
  latencyMs: number | null;
  sampleModels: string[];
}

/**
 * Provider-neutral adapter contract. Everything provider-specific lives behind
 * this interface so the generation engine never branches on provider identity.
 */
export interface ProviderAdapter {
  readonly id: AiProviderId;
  readonly label: string;
  isConfigured(): boolean;
  /** Human-readable, actionable description of what is missing. Never echoes a key. */
  setupHint(): string;
  /**
   * Discovers models. Must never invent a model or assume free eligibility from
   * a name. Returns an empty array when discovery is unsupported.
   */
  listModels(signal?: AbortSignal): Promise<ProviderModelInfo[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;
}

export type ProviderErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'model_unavailable'
  | 'bad_request'
  | 'timeout'
  | 'cancelled'
  | 'server_error'
  | 'network'
  | 'malformed_response'
  | 'unknown';

/**
 * Normalized provider failure. `retryable` distinguishes transient conditions
 * from permanent ones so the router does not retry a bad key or a 400 forever.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: AiProviderId,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly retryable: boolean = false,
    readonly providerRequestId?: string | null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get isPermanent(): boolean {
    return !this.retryable;
  }
}

export function classifyStatus(provider: AiProviderId, status: number, body: string): ProviderError {
  const snippet = body.slice(0, 400).replace(/\s+/g, ' ').trim();
  switch (true) {
    case status === 401:
      return new ProviderError(
        provider,
        'unauthorized',
        `${provider} rejected the API key (401). Check the server-side key configuration.`,
        401,
        false,
      );
    case status === 403:
      return new ProviderError(
        provider,
        'forbidden',
        `${provider} denied access (403). The key may lack the required scope or the model may be restricted.`,
        403,
        false,
      );
    case status === 404:
      return new ProviderError(
        provider,
        'model_unavailable',
        `${provider} reported the model as unavailable (404).`,
        404,
        false,
      );
    case status === 408:
      return new ProviderError(provider, 'timeout', `${provider} timed out (408).`, 408, true);
    case status === 429:
      return new ProviderError(
        provider,
        'rate_limited',
        `${provider} rate-limited the request (429).`,
        429,
        true,
      );
    case status >= 500:
      return new ProviderError(
        provider,
        'server_error',
        `${provider} returned ${status}.`,
        status,
        true,
      );
    case status === 400 || status === 422:
      return new ProviderError(
        provider,
        'bad_request',
        `${provider} rejected the request (${status}): ${snippet}`,
        status,
        false,
      );
    default:
      return new ProviderError(
        provider,
        'unknown',
        `${provider} returned ${status}: ${snippet}`,
        status,
        status >= 500,
      );
  }
}

/**
 * Shared fetch wrapper: applies a timeout, forwards cancellation, and converts
 * low-level network failures into normalized ProviderErrors.
 */
export async function providerFetch(
  provider: AiProviderId,
  url: string,
  init: RequestInit & { timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(init.signal?.reason);
  if (init.signal) {
    if (init.signal.aborted) throw new ProviderError(provider, 'cancelled', 'Request cancelled', undefined, false);
    init.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error('provider-timeout')),
    init.timeoutMs,
  );

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (init.signal?.aborted) {
      throw new ProviderError(provider, 'cancelled', 'Request cancelled', undefined, false);
    }
    if (controller.signal.aborted) {
      throw new ProviderError(
        provider,
        'timeout',
        `${provider} did not respond within ${init.timeoutMs}ms.`,
        undefined,
        true,
      );
    }
    throw new ProviderError(
      provider,
      'network',
      `Could not reach ${provider}: ${e instanceof Error ? e.message : String(e)}`,
      undefined,
      true,
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

/** Parses a provider price field, which may be a string or a number. */
export function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

/**
 * Derives free eligibility from provider pricing metadata.
 *
 * This is the ONLY sanctioned way to decide a model is free. A model name is
 * never sufficient evidence: `:free` suffixes have been added and removed over
 * time, and paid models have carried misleading names.
 */
export function deriveEligibility(
  promptPricePerMillion: number | null,
  completionPricePerMillion: number | null,
): FreeEligibility {
  if (promptPricePerMillion === null || completionPricePerMillion === null) return 'unknown';
  if (promptPricePerMillion === 0 && completionPricePerMillion === 0) return 'verified-free';
  return 'paid';
}
