export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = 'api_error', details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const RAW_API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ?? '';
/** Same-origin `/api/v1` in dev (Vite proxies it); absolute API origin in prod. */
const API_BASE = RAW_API_BASE ? `${RAW_API_BASE}/api/v1` : '/api/v1';

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    rawText = false,
  ): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      const errorBody = (await res.json().catch(() => ({}))) as ApiErrorBody;
      throw new ApiClientError(
        401,
        errorBody.error?.message ?? 'Your session has expired. Please sign in again.',
        errorBody.error?.code ?? 'unauthorized',
      );
    }
    if (res.status === 429) {
      throw new ApiClientError(429, 'You are moving too fast. Wait a moment and try again.', 'rate_limited');
    }

    if (!res.ok) {
      let errorBody: ApiErrorBody = {};
      let nonJson = false;
      try {
        errorBody = (await res.json()) as ApiErrorBody;
      } catch {
        /* non-JSON error body (e.g. a hosting fallback page or a dead dev proxy) */
        nonJson = true;
      }
      if (nonJson) {
        // The request never reached the Express API: the dev proxy is down, or
        // the deployed host rewrote /api/* to index.html (Firebase Hosting
        // SPA fallback). The backend's own errors are always JSON.
        const hint =
          'The API server did not respond at /api/v1. ' +
          'In dev, start it with `pnpm --filter @wolf-forge/api dev` (port 3001). ' +
          'In production, set VITE_API_BASE_URL to the deployed API origin ' +
          '(and add the web origin to WEB_ORIGIN for CORS).';
        throw new ApiClientError(res.status, hint, 'api_not_reachable');
      }
      throw new ApiClientError(
        res.status,
        errorBody.error?.message ?? `Request failed with status ${res.status}.`,
        errorBody.error?.code ?? 'api_error',
        errorBody.error?.details,
      );
    }

    if (rawText) return (await res.text()) as unknown as T;
    return (await res.json()) as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, body);
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }

  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }

  getText(path: string) {
    return this.request<string>('GET', path, undefined, true);
  }
}

export const api = new ApiClient();
export { API_BASE };

/** Encode a file path into a URL-safe form for route params. */
export function encodeFilePath(path: string): string {
  return path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

export interface SSEHandler {
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

/** Open an SSE stream with bearer auth; returns a close function. */
export function openSse(path: string, token: string, handler: SSEHandler): () => void {
  const controller = new AbortController();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = async () => {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE stream failed: HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const chunk of events) {
          let eventType = 'message';
          let data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) {
            try {
              handler.onEvent?.(eventType, JSON.parse(data) as Record<string, unknown>);
            } catch {
              handler.onEvent?.(eventType, { _raw: data });
            }
          }
        }
      }
      handler.onClose?.();
    } catch (err) {
      if (controller.signal.aborted) {
        handler.onClose?.();
        return;
      }
      handler.onError?.(err instanceof Error ? err : new Error(String(err)));
      // Auto-retry with backoff unless aborted.
      retryTimer = setTimeout(() => void connect(), 2500);
    }
  };

  void connect();

  return () => {
    controller.abort();
    if (retryTimer) clearTimeout(retryTimer);
  };
}