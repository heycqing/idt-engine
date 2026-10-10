import crypto from 'node:crypto';

/**
 * Normalizes intent string:
 * - trim
 * - consecutive whitespace (including \r, \n, \t) collapsed into a single space
 * - ASCII 'A'-'Z' converted to 'a'-'z' (Chinese characters unchanged)
 */
export function normalizeIntent(intent: string): string {
  return intent
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * Derives a deterministic flowId from the normalized intent:
 * - SHA-256 hash of normalized intent
 * - first 10 hex characters
 * - prefixed with "flow_"
 */
export function flowIdFromIntent(intent: string): string {
  const normalized = normalizeIntent(intent);
  const hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `flow_${hash.slice(0, 10)}`;
}
