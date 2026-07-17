import { logError } from '../utils/logger';

/**
 * Per-field JSON.parse for Redis hash reads (HGETALL). One corrupt field is
 * logged and skipped instead of throwing away the whole read — a single bad
 * value must never null an entire entity hash for its consumers.
 */
export function parseHashValues<T>(
  hash: Record<string, string>,
  context: Record<string, unknown>,
): T[] {
  const values: T[] = [];
  for (const [field, raw] of Object.entries(hash)) {
    try {
      values.push(JSON.parse(raw) as T);
    } catch (error) {
      logError('Skipping corrupt cache hash field', error, { ...context, field });
    }
  }
  return values;
}

/**
 * Entry-preserving variant for readers that key their result by hash field
 * (e.g. FixturesByTeam / live-by-team maps).
 */
export function parseHashEntries<T>(
  hash: Record<string, string>,
  context: Record<string, unknown>,
): Array<[field: string, value: T]> {
  const entries: Array<[string, T]> = [];
  for (const [field, raw] of Object.entries(hash)) {
    try {
      entries.push([field, JSON.parse(raw) as T]);
    } catch (error) {
      logError('Skipping corrupt cache hash field', error, { ...context, field });
    }
  }
  return entries;
}
