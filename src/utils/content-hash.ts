import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return serialized;
}

function serializePostgresJsonb(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(serializePostgresJsonb).join(', ')}]`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort(
        (left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0),
      )
      .map((key) => `${JSON.stringify(key)}: ${serializePostgresJsonb(record[key])}`);
    return `{${entries.join(', ')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return serialized;
}

/** JSON representation matching PostgreSQL jsonb's length-then-byte key order. */
export function postgresJsonbCanonicalJson(value: unknown): string {
  return serializePostgresJsonb(value);
}

export function postgresJsonbContentHash(value: unknown): string {
  return createHash('sha256').update(postgresJsonbCanonicalJson(value), 'utf8').digest('hex');
}

/** Cryptographic hash for normalized source payloads and persistence fences. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
