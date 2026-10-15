import type { Request, Response } from 'express';

export const SSE_TYPES = new Set([
  'text/event-stream',
  'text/event-stream; charset=utf-8',
  'text/event-stream;charset=utf-8',
]);

export const SSE_CONTENT_TYPES = [
  'text/event-stream; charset=utf-8',
  'text/event-stream;charset=utf-8',
  'text/event-stream',
];

// Every header that must not be copied verbatim when an API response is
// streamed back to the browser (hop-by-hop plus application-controlled).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'content-length',
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'content-encoding',
]);

/**
 * Proxies an API-internal server to the browser WITHOUT streaming body bytes.
 *
 * The body is buffered unchanged, then delivered to the client with a
 * `content-length` header so the browser considers the request complete after
 * receiving a finite number of bytes. This keeps preview connections stable
 * for long-lived pages like OpenAI-style streaming or EventSource.
 */
export async function proxySlowResponse(
  internal: Response,
  outbound: Response,
  outboundUrl: string,
): Promise<void> {
  const internalBody = await readBody(internal);
  outbound.status(internal.statusCode);
  for (const [key, value] of Object.entries(internal.getHeaders())) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    const lower = key.toLowerCase();
    if (lower === 'content-type' && SSE_TYPES.has(String(value))) {
      outbound.setHeader('content-type', 'text/event-stream; charset=utf-8');
      continue;
    }
    if (typeof value === 'string') {
      outbound.setHeader(key, value);
    } else if (Array.isArray(value)) {
      outbound.setHeader(key, value);
    }
  }
  // Content-type may not have been copied if the internal server did not set
  // it explicitly; default to JSON.
  if (!outbound.getHeader('content-type')) {
    outbound.setHeader('content-type', 'application/json; charset=utf-8');
  }
  outbound.setHeader('content-length', Buffer.byteLength(internalBody));
  outbound.setHeader('x-wolf-forge-proxied-from', outboundUrl.slice(0, 200));
  outbound.end(internalBody);
}

async function readBody(internal: Response): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    internal.on('data', (chunk: Buffer) => chunks.push(chunk));
    internal.on('end', () => resolve(Buffer.concat(chunks)));
    internal.on('error', reject);
  });
}

/** Builds the outbound response metadata for the preview proxy. */
export function previewProxyMeta(req: Request, proxyPort: number): { url: string } {
  // Only loopback, never a remote URL. The caller must already have validated
  // `proxyPort` to be in the trusted range.
  return { url: `http://127.0.0.1:${proxyPort}${req.url}` };
}