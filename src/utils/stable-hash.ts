/**
 * Deterministic non-cryptographic hash (FNV-1a, 32-bit) for stable identifiers —
 * e.g. BullMQ job IDs that must dedupe repeat triggers with identical payloads.
 * NOT for security use.
 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
