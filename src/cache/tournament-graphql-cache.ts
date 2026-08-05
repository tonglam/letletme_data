import { redisSingleton } from './singleton';
import { logError, logInfo } from '../utils/logger';

const TOURNAMENT_CACHE_PATTERNS = ['gql:v2:*:tournament:*', 'gql:v2:*:tournaments:*'] as const;

async function scanKeys(pattern: string): Promise<string[]> {
  const redis = await redisSingleton.getClient();
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 250);
    keys.push(...found);
    cursor = nextCursor;
  } while (cursor !== '0');
  return keys;
}

/**
 * Tournament GraphQL responses use a 60-second cache in the sibling service.
 * Lifecycle mutations are rare, so one bounded namespace invalidation is both
 * safer and simpler than trying to reconstruct every argument-encoded key.
 * Progress heartbeats never call this function.
 */
export async function invalidateTournamentGraphQLCaches(reason: string): Promise<number> {
  if (!process.env.DATABASE_URL) return 0;
  try {
    const redis = await redisSingleton.getClient();
    const keys = [...new Set((await Promise.all(TOURNAMENT_CACHE_PATTERNS.map(scanKeys))).flat())];
    if (keys.length === 0) return 0;

    let removed = 0;
    for (let index = 0; index < keys.length; index += 500) {
      removed += await redis.del(...keys.slice(index, index + 500));
    }
    logInfo('Invalidated tournament GraphQL caches', { reason, removed });
    return removed;
  } catch (error) {
    logError('Failed to invalidate tournament GraphQL caches', error, { reason });
    return 0;
  }
}
