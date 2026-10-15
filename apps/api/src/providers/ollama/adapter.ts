import net from 'node:net';
import type { ModelCapability } from '@wolf-forge/shared-types';
import {
  ProviderError,
  providerFetch,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderModelInfo,
} from '../types.js';

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    details?: { parameter_size?: string; family?: string };
  }>;
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  enabled: boolean;
}

/**
 * Validates an Ollama base URL before any request is made.
 *
 * Ollama has no authentication and can execute model pulls, so an attacker who
 * could point Wolf Forge at an arbitrary URL would gain an SSRF primitive and a
 * way to reach internal services. We therefore only permit loopback and private
 * addresses, and explicitly refuse link-local addresses (which is where cloud
 * instance metadata lives).
 */
export function assertAllowedOllamaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError(
      'ollama',
      'bad_request',
      'OLLAMA_BASE_URL is not a valid URL.',
      undefined,
      false,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('ollama', 'bad_request', 'OLLAMA_BASE_URL must use http or https.');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '0.0.0.0' || host === '::') {
    throw new ProviderError(
      'ollama',
      'bad_request',
      'OLLAMA_BASE_URL must not bind to a wildcard address.',
    );
  }

  const isIp = net.isIP(host) !== 0;
  const loopbackNames = new Set(['localhost', 'host.docker.internal', 'host.containers.internal']);
  const privateNames = new Set(['ollama', 'ollama.local']);

  if (!isIp && !loopbackNames.has(host) && !privateNames.has(host)) {
    throw new ProviderError(
      'ollama',
      'bad_request',
      'OLLAMA_BASE_URL must point at loopback, a container-network hostname, or a private address.',
    );
  }

  if (isIp && !isAllowedIp(host)) {
    throw new ProviderError(
      'ollama',
      'bad_request',
      `Refusing to use ${host} for Ollama: only loopback and private ranges are allowed.`,
    );
  }

  return url;
}

function isAllowedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    // 169.254.0.0/16 is link-local: includes cloud metadata. Never allowed.
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  // fc00::/7 unique local addresses
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}

/**
 * Optional local-inference adapter. Free in the sense that no API is billed,
 * but the operator supplies the compute. This is stated plainly in the UI.
 */
export class OllamaAdapter implements ProviderAdapter {
  readonly id = 'ollama' as const;
  readonly label = 'Ollama (local)';

  constructor(private readonly options: OllamaOptions) {}

  isConfigured(): boolean {
    return this.options.enabled && this.options.model.length > 0 && this.options.baseUrl.length > 0;
  }

  setupHint(): string {
    return this.isConfigured()
      ? `Configured for ${this.options.model} at ${this.options.baseUrl}. Inference runs on this machine's hardware.`
      : 'Optional. Set OLLAMA_ENABLED=true and OLLAMA_MODEL=<name> to use a local model. Requires Ollama running on this host; you supply the compute.';
  }

  private base(): string {
    return assertAllowedOllamaUrl(this.options.baseUrl).toString().replace(/\/+$/, '');
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModelInfo[]> {
    if (!this.isConfigured()) return [];
    const res = await providerFetch(this.id, `${this.base()}/api/tags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 10_000,
      signal,
    });
    if (!res.ok) {
      throw new ProviderError(
        this.id,
        res.status === 404 ? 'model_unavailable' : 'server_error',
        `Ollama returned ${res.status}. Is the daemon running?`,
        res.status,
        res.status >= 500,
      );
    }
    let payload: OllamaTagsResponse;
    try {
      payload = (await res.json()) as OllamaTagsResponse;
    } catch {
      throw new ProviderError(this.id, 'malformed_response', 'Ollama returned unparseable JSON.');
    }

    return (payload.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => {
        const capabilities: ModelCapability[] = ['chat', 'streaming'];
        return {
          modelId: name,
          displayName: `${name} (local)`,
          // Ollama's tags endpoint does not report a context window.
          contextLength: null,
          maxOutputTokens: null,
          promptPricePerMillion: 0,
          completionPricePerMillion: 0,
          capabilities,
          // Local inference costs no API money; the operator pays in hardware.
          eligibility: 'verified-free' as const,
        } satisfies ProviderModelInfo;
      });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new ProviderError(
        this.id,
        'unauthorized',
        'Ollama is not enabled on this server.',
        undefined,
        false,
      );
    }

    const body = {
      model: request.model,
      messages: request.messages,
      stream: false,
      ...(request.jsonMode ? { format: 'json' } : {}),
      options: {
        temperature: request.temperature ?? 0.4,
        num_predict: request.maxTokens,
      },
    };

    const res = await providerFetch(this.id, `${this.base()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        this.id,
        res.status === 404 ? 'model_unavailable' : 'server_error',
        res.status === 404
          ? `Ollama does not have the model "${request.model}" pulled. Run: ollama pull ${request.model}`
          : `Ollama returned ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        res.status >= 500,
      );
    }

    let parsed: OllamaChatResponse;
    try {
      parsed = (await res.json()) as OllamaChatResponse;
    } catch {
      throw new ProviderError(this.id, 'malformed_response', 'Ollama returned a non-JSON body.');
    }

    const text = parsed.message?.content ?? '';
    if (!text) {
      throw new ProviderError(
        this.id,
        'malformed_response',
        'Ollama returned an empty completion.',
        undefined,
        true,
      );
    }

    return {
      text,
      model: parsed.model ?? request.model,
      provider: this.id,
      usage: {
        promptTokens: parsed.prompt_eval_count ?? null,
        completionTokens: parsed.eval_count ?? null,
        costUsd: 0,
      },
      providerRequestId: null,
      finishReason: parsed.done_reason ?? null,
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
      const present = models.some((m) => m.modelId === this.options.model);
      return {
        ok: models.length > 0,
        message:
          models.length === 0
            ? 'Ollama is reachable but has no models pulled.'
            : present
              ? `Ollama is reachable and "${this.options.model}" is available.`
              : `Ollama is reachable, but "${this.options.model}" is not pulled. Run: ollama pull ${this.options.model}`,
        latencyMs,
        sampleModels: models.slice(0, 8).map((m) => m.modelId),
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof ProviderError ? e.message : `Ollama probe failed: ${String(e)}`,
        latencyMs: Date.now() - started,
        sampleModels: [],
      };
    }
  }
}
