/**
 * Central redaction. Every log line and every stored build event passes through
 * here, because generated code, provider errors and user prompts can all carry
 * credentials by accident.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Provider keys
  [/sk-or-v1-[A-Za-z0-9]{16,}/g, '[redacted:openrouter-key]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted:api-key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[redacted:google-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted:github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted:slack-token]'],
  // JWT / bearer tokens
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted:jwt]'],
  // PEM blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  // Assignment-style secrets
  [
    /\b([A-Z0-9_]*(?:API_?KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"',]{8,})/gi,
    '$1=[redacted]',
  ],
];

export function redact(input: string, maxLength = 20_000): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement);
  }
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength)}\n… [truncated ${out.length - maxLength} characters]`;
  }
  return out;
}

/** Redacts every string value in a nested structure, leaving keys intact. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 6) return '[redacted:depth]' as unknown as T;
  if (typeof value === 'string') return redact(value, 4_000) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** Never log a key, even partially. Returns only a non-reversible fingerprint. */
export function keyFingerprint(key: string): string {
  if (!key) return 'absent';
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return `len=${key.length} fp=${(h >>> 0).toString(16)}`;
}
