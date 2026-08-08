import { createHash } from 'node:crypto';

import { CacheError } from '../utils/errors';

export const LEGACY_REDIS_CLEANUP_GROUPS = {
  dataCache: [
    'Season:active',
    'event:current',
    'CoreSnapshotPublication:pending',
    'CoreSnapshotStage:*',
    'CoreSnapshotBackup:*',
    'Event:*',
    'Team:*',
    'Phase:*',
    'Player:*',
    'PlayerStat:*',
    'EntryInfo:*',
    'Fixtures:*',
    'FixturesByTeam:*',
    'EventLive:*',
    'EventLiveExplain:*',
    'EventLiveExplainV2:*',
    'EventLiveSummary:*',
    'EventOverallResult:*',
    'LiveFixture:*',
    'LiveFixtureV2:*',
    'LiveBonus:*',
    'LiveBonusV2:*',
    'LiveSnapshotMeta:*',
    'PlayerValue:*',
    'Understat:*',
  ],
  dataCoordination: [
    'LaunchNotification:*',
    'letletme:entry-info-sync:daily:*',
    'mutation-lock:*',
    'tournament-cascade:*',
  ],
  graphqlCache: ['gql:v2:*', 'player_state:*', 'PlayerValueMissing:*'],
  legacyQueueDb0: [
    'bull:data-sync:*',
    'bull:entry-sync:*',
    'bull:league-sync:*',
    'bull:live-data:*',
    'bull:tournament-sync:*',
    'bull:tournament-setup:*',
    'bull:data-sync-p0:*',
    'bull:data-sync-p1:*',
    'bull:data-sync-p2:*',
    'bull:data-sync-p3:*',
    'bull:entry-sync-p0:*',
    'bull:entry-sync-p1:*',
    'bull:entry-sync-p2:*',
    'bull:entry-sync-p3:*',
    'bull:league-sync-p0:*',
    'bull:league-sync-p1:*',
    'bull:league-sync-p2:*',
    'bull:league-sync-p3:*',
    'bull:live-data-p0:*',
    'bull:live-data-p1:*',
    'bull:live-data-p2:*',
    'bull:live-data-p3:*',
    'bull:tournament-sync-p0:*',
    'bull:tournament-sync-p1:*',
    'bull:tournament-sync-p2:*',
    'bull:tournament-sync-p3:*',
    'bull:tournament-setup-p0:*',
    'bull:tournament-setup-p1:*',
    'bull:tournament-setup-p2:*',
    'bull:tournament-setup-p3:*',
    'bull:understat-player-sync:*',
    'bull:understat-team-sync:*',
  ],
} as const;

export type LegacyRedisCleanupGroup = keyof typeof LEGACY_REDIS_CLEANUP_GROUPS;

export interface LegacyCleanupRedis {
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[cursor: string, keys: string[]]>;
  unlink(...keys: string[]): Promise<number>;
}

export interface LegacyRedisCleanupOptions {
  readonly groups: readonly LegacyRedisCleanupGroup[];
  readonly dryRun?: boolean;
  readonly scanCount?: number;
  readonly unlinkBatchSize?: number;
  readonly maxKeys?: number;
}

export interface LegacyRedisCleanupResult {
  readonly dryRun: boolean;
  readonly groups: readonly LegacyRedisCleanupGroup[];
  readonly patterns: readonly string[];
  readonly matchedKeys: number;
  readonly unlinkedKeys: number;
  readonly keyManifestSha256: string;
  readonly keys: readonly string[];
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new CacheError('Invalid legacy Redis cleanup bound', 'LEGACY_CLEANUP_BOUND_INVALID');
  }
  return resolved;
}

function resolvePatterns(groups: readonly LegacyRedisCleanupGroup[]): string[] {
  if (groups.length === 0) {
    throw new CacheError(
      'At least one legacy Redis cleanup group is required',
      'LEGACY_CLEANUP_GROUP_REQUIRED',
    );
  }
  const uniqueGroups = [...new Set(groups)];
  if (uniqueGroups.length !== groups.length) {
    throw new CacheError(
      'Legacy Redis cleanup groups must be unique',
      'LEGACY_CLEANUP_GROUP_DUPLICATE',
    );
  }
  const patterns = uniqueGroups.flatMap((group) => [...LEGACY_REDIS_CLEANUP_GROUPS[group]]);
  if (patterns.some((pattern) => pattern.startsWith('llm:v3:'))) {
    throw new CacheError(
      'A v3 namespace cannot be included in legacy cleanup',
      'LEGACY_CLEANUP_V3_NAMESPACE_FORBIDDEN',
    );
  }
  return patterns;
}

async function scanPattern(
  redis: LegacyCleanupRedis,
  pattern: string,
  scanCount: number,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', scanCount);
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== '0');
  return keys;
}

/**
 * Retires only frozen v2 key families. The caller must choose explicit groups;
 * dry-run is the default. This function intentionally has no DEL/FLUSH path.
 */
export async function cleanupLegacyRedisKeys(
  redis: LegacyCleanupRedis,
  options: LegacyRedisCleanupOptions,
): Promise<LegacyRedisCleanupResult> {
  const patterns = resolvePatterns(options.groups);
  const scanCount = boundedInteger(options.scanCount, 500, 10, 10_000);
  const unlinkBatchSize = boundedInteger(options.unlinkBatchSize, 100, 1, 1_000);
  const maxKeys = boundedInteger(options.maxKeys, 10_000, 1, 1_000_000);
  const dryRun = options.dryRun ?? true;
  const matched = new Set<string>();

  for (const pattern of patterns) {
    const keys = await scanPattern(redis, pattern, scanCount);
    for (const key of keys) matched.add(key);
    if (matched.size > maxKeys) {
      throw new CacheError(
        `Legacy Redis cleanup matched more than ${maxKeys} keys`,
        'LEGACY_CLEANUP_MAX_KEYS_EXCEEDED',
      );
    }
  }

  const keys = [...matched].sort();
  const keyManifestSha256 = createHash('sha256').update(keys.join('\n')).digest('hex');
  let unlinkedKeys = 0;
  if (!dryRun) {
    for (let offset = 0; offset < keys.length; offset += unlinkBatchSize) {
      unlinkedKeys += await redis.unlink(...keys.slice(offset, offset + unlinkBatchSize));
    }
  }

  return {
    dryRun,
    groups: [...options.groups],
    patterns,
    matchedKeys: keys.length,
    unlinkedKeys,
    keyManifestSha256,
    keys,
  };
}
