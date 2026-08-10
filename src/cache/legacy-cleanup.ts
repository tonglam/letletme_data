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

export interface LegacyQueueRelocationRedis extends LegacyCleanupRedis {
  type(key: string): Promise<string>;
  callBuffer(command: string, ...args: (string | number | Buffer)[]): Promise<unknown>;
  dumpBuffer(key: string): Promise<Buffer | null>;
  pttl(key: string): Promise<number>;
  restore(key: string, ttlMilliseconds: number, serializedValue: Buffer): Promise<'OK'>;
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

export interface LegacyQueueRelocationOptions {
  readonly dryRun?: boolean;
  readonly scanCount?: number;
  readonly maxKeys?: number;
  readonly ttlToleranceMs?: number;
}

export interface LegacyQueueRelocationResult {
  readonly dryRun: boolean;
  readonly matchedKeys: number;
  readonly copiedKeys: number;
  readonly alreadyPresentKeys: number;
  readonly pendingKeys: number;
  readonly keyManifestSha256: string;
  readonly payloadManifestSha256: string;
  readonly keys: readonly string[];
}

export interface LegacyQueueManifest {
  readonly keyCount: number;
  readonly keyManifestSha256: string;
  readonly payloadManifestSha256: string;
  readonly keys: readonly string[];
}

export interface RuntimeQueueManifest extends LegacyQueueManifest {
  readonly ignoredEphemeralKeyCount: number;
  readonly ignoredEphemeralKeys: readonly string[];
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new CacheError('Invalid legacy Redis cleanup bound', 'LEGACY_CLEANUP_BOUND_INVALID');
  }
  return resolved;
}

export function resolveLegacyRedisCleanupPatterns(
  groups: readonly LegacyRedisCleanupGroup[],
): string[] {
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

async function scanPatterns(
  redis: LegacyCleanupRedis,
  patterns: readonly string[],
  scanCount: number,
  maxKeys: number,
): Promise<string[]> {
  const matched = new Set<string>();
  for (const pattern of patterns) {
    const keys = await scanPattern(redis, pattern, scanCount);
    for (const key of keys) matched.add(key);
    if (matched.size > maxKeys) {
      throw new CacheError(
        `Legacy Redis operation matched more than ${maxKeys} keys`,
        'LEGACY_CLEANUP_MAX_KEYS_EXCEEDED',
      );
    }
  }
  return [...matched].sort();
}

function keyManifestSha256(keys: readonly string[]): string {
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}

function ttlMatches(sourceTtl: number, targetTtl: number, toleranceMs: number): boolean {
  if (sourceTtl === -1) return targetTtl === -1;
  if (sourceTtl < 0 || targetTtl < 0) return false;
  return Math.abs(sourceTtl - targetTtl) <= toleranceMs;
}

function bufferArray(value: unknown, command: string): Buffer[] {
  if (!Array.isArray(value) || value.some((item) => !Buffer.isBuffer(item))) {
    throw new CacheError(
      `Unexpected binary Redis reply for ${command}`,
      'LEGACY_QUEUE_LOGICAL_HASH_FAILED',
    );
  }
  return value as Buffer[];
}

function canonicalBufferValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(canonicalBufferValue);
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  throw new CacheError(
    'Unexpected Redis value while computing a logical hash',
    'LEGACY_QUEUE_LOGICAL_HASH_FAILED',
  );
}

async function logicalPayloadDigest(
  redis: LegacyQueueRelocationRedis,
  key: string,
): Promise<string> {
  const type = await redis.type(key);
  let logicalValue: unknown;

  switch (type) {
    case 'string':
      logicalValue = await redis.callBuffer('GET', key);
      break;
    case 'hash': {
      const flat = bufferArray(await redis.callBuffer('HGETALL', key), 'HGETALL');
      const pairs: [Buffer, Buffer][] = [];
      for (let index = 0; index < flat.length; index += 2) {
        const field = flat[index];
        const fieldValue = flat[index + 1];
        if (!field || !fieldValue) {
          throw new CacheError(
            `Invalid hash payload for queue key: ${key}`,
            'LEGACY_QUEUE_LOGICAL_HASH_FAILED',
          );
        }
        pairs.push([field, fieldValue]);
      }
      pairs.sort(([left], [right]) => Buffer.compare(left, right));
      logicalValue = pairs;
      break;
    }
    case 'list':
      logicalValue = await redis.callBuffer('LRANGE', key, 0, -1);
      break;
    case 'set': {
      const members = bufferArray(await redis.callBuffer('SMEMBERS', key), 'SMEMBERS');
      members.sort(Buffer.compare);
      logicalValue = members;
      break;
    }
    case 'zset':
      logicalValue = await redis.callBuffer('ZRANGE', key, 0, -1, 'WITHSCORES');
      break;
    case 'stream':
      logicalValue = await redis.callBuffer('XRANGE', key, '-', '+');
      break;
    default:
      throw new CacheError(
        `Unsupported queue Redis type ${type} for key: ${key}`,
        'LEGACY_QUEUE_LOGICAL_HASH_FAILED',
      );
  }

  return createHash('sha256')
    .update(JSON.stringify([type, canonicalBufferValue(logicalValue)]))
    .digest('hex');
}

export async function inspectLegacyRedisQueues(
  redis: LegacyQueueRelocationRedis,
  options: Pick<LegacyQueueRelocationOptions, 'scanCount' | 'maxKeys'> = {},
): Promise<LegacyQueueManifest> {
  const scanCount = boundedInteger(options.scanCount, 500, 10, 10_000);
  const maxKeys = boundedInteger(options.maxKeys, 10_000, 1, 1_000_000);
  const patterns = resolveLegacyRedisCleanupPatterns(['legacyQueueDb0']);
  const keys = await scanPatterns(redis, patterns, scanCount, maxKeys);
  const payloadRows: string[] = [];
  for (const key of keys) {
    payloadRows.push(`${key}\u0000${await logicalPayloadDigest(redis, key)}`);
  }
  return {
    keyCount: keys.length,
    keyManifestSha256: keyManifestSha256(keys),
    payloadManifestSha256: createHash('sha256').update(payloadRows.join('\n')).digest('hex'),
    keys,
  };
}

/**
 * Produces a stable runtime queue manifest while API and workers are stopped.
 * BullMQ's stalled checker writes one short-lived lease per queue. That lease
 * can expire after SCAN and is not durable job state, so it is the only key
 * excluded from this redeploy-time comparison. The exact cutover manifest
 * above remains unchanged and continues to include every copied key.
 */
export async function inspectRuntimeRedisQueues(
  redis: LegacyQueueRelocationRedis,
  options: Pick<LegacyQueueRelocationOptions, 'scanCount' | 'maxKeys'> = {},
): Promise<RuntimeQueueManifest> {
  const scanCount = boundedInteger(options.scanCount, 500, 10, 10_000);
  const maxKeys = boundedInteger(options.maxKeys, 10_000, 1, 1_000_000);
  const patterns = resolveLegacyRedisCleanupPatterns(['legacyQueueDb0']);
  const scannedKeys = await scanPatterns(redis, patterns, scanCount, maxKeys);
  const ignoredEphemeralKeys = scannedKeys.filter((key) => key.endsWith(':stalled-check'));
  const keys = scannedKeys.filter((key) => !key.endsWith(':stalled-check'));
  const payloadRows: string[] = [];
  for (const key of keys) {
    payloadRows.push(`${key}\u0000${await logicalPayloadDigest(redis, key)}`);
  }
  return {
    keyCount: keys.length,
    keyManifestSha256: keyManifestSha256(keys),
    payloadManifestSha256: createHash('sha256').update(payloadRows.join('\n')).digest('hex'),
    keys,
    ignoredEphemeralKeyCount: ignoredEphemeralKeys.length,
    ignoredEphemeralKeys,
  };
}

/**
 * Copies the complete allowlisted BullMQ state from the legacy cache DB to the
 * independently configured queue DB. Existing identical target keys make the
 * operation idempotent; conflicting or unexpected target keys fail closed.
 */
export async function relocateLegacyRedisQueues(
  source: LegacyQueueRelocationRedis,
  target: LegacyQueueRelocationRedis,
  options: LegacyQueueRelocationOptions = {},
): Promise<LegacyQueueRelocationResult> {
  const dryRun = options.dryRun ?? true;
  const scanCount = boundedInteger(options.scanCount, 500, 10, 10_000);
  const maxKeys = boundedInteger(options.maxKeys, 10_000, 1, 1_000_000);
  const ttlToleranceMs = boundedInteger(options.ttlToleranceMs, 5_000, 0, 60_000);
  const patterns = resolveLegacyRedisCleanupPatterns(['legacyQueueDb0']);
  const sourceKeys = await scanPatterns(source, patterns, scanCount, maxKeys);
  const targetKeys = await scanPatterns(target, patterns, scanCount, maxKeys);
  const sourceKeySet = new Set(sourceKeys);
  const unexpectedTargetKeys = targetKeys.filter((key) => !sourceKeySet.has(key));

  if (unexpectedTargetKeys.length > 0) {
    throw new CacheError(
      `Queue Redis contains ${unexpectedTargetKeys.length} unexpected legacy keys`,
      'LEGACY_QUEUE_TARGET_NOT_EMPTY',
    );
  }

  let copiedKeys = 0;
  let alreadyPresentKeys = 0;
  let pendingKeys = 0;
  const payloadManifestRows: string[] = [];

  for (const key of sourceKeys) {
    const sourceDump = await source.dumpBuffer(key);
    const sourceTtl = await source.pttl(key);
    if (!sourceDump || sourceTtl === -2) {
      throw new CacheError(
        `Legacy queue key disappeared during relocation: ${key}`,
        'LEGACY_QUEUE_SOURCE_CHANGED',
      );
    }

    const sourceDigest = await logicalPayloadDigest(source, key);
    payloadManifestRows.push(`${key}\u0000${sourceDigest}`);
    let targetDump = await target.dumpBuffer(key);
    const targetWasPresent = targetDump !== null;

    if (!targetDump) {
      pendingKeys += 1;
      if (dryRun) continue;

      const restoreTtl = sourceTtl === -1 ? 0 : Math.max(1, sourceTtl);
      await target.restore(key, restoreTtl, sourceDump);
      copiedKeys += 1;
      targetDump = await target.dumpBuffer(key);
    }

    const targetTtl = await target.pttl(key);
    const targetDigest = targetDump ? await logicalPayloadDigest(target, key) : null;
    if (targetDigest !== sourceDigest || !ttlMatches(sourceTtl, targetTtl, ttlToleranceMs)) {
      throw new CacheError(
        `Queue Redis payload conflict for key: ${key}`,
        'LEGACY_QUEUE_TARGET_CONFLICT',
      );
    }

    if (targetWasPresent) {
      alreadyPresentKeys += 1;
    }
  }

  return {
    dryRun,
    matchedKeys: sourceKeys.length,
    copiedKeys,
    alreadyPresentKeys,
    pendingKeys: dryRun ? pendingKeys : 0,
    keyManifestSha256: keyManifestSha256(sourceKeys),
    payloadManifestSha256: createHash('sha256')
      .update(payloadManifestRows.join('\n'))
      .digest('hex'),
    keys: sourceKeys,
  };
}

/**
 * Retires only frozen v2 key families. The caller must choose explicit groups;
 * dry-run is the default. This function intentionally has no DEL/FLUSH path.
 */
export async function cleanupLegacyRedisKeys(
  redis: LegacyCleanupRedis,
  options: LegacyRedisCleanupOptions,
): Promise<LegacyRedisCleanupResult> {
  const patterns = resolveLegacyRedisCleanupPatterns(options.groups);
  const scanCount = boundedInteger(options.scanCount, 500, 10, 10_000);
  const unlinkBatchSize = boundedInteger(options.unlinkBatchSize, 100, 1, 1_000);
  const maxKeys = boundedInteger(options.maxKeys, 10_000, 1, 1_000_000);
  const dryRun = options.dryRun ?? true;
  const keys = await scanPatterns(redis, patterns, scanCount, maxKeys);
  const manifestSha256 = keyManifestSha256(keys);
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
    keyManifestSha256: manifestSha256,
    keys,
  };
}
