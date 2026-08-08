import { describe, expect, test } from 'bun:test';

import { cleanupLegacyRedisKeys, type LegacyCleanupRedis } from '../../src/cache/legacy-cleanup';

function redisGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`);
}

class FakeRedis implements LegacyCleanupRedis {
  readonly keys: Set<string>;
  readonly unlinks: string[][] = [];

  constructor(keys: readonly string[]) {
    this.keys = new Set(keys);
  }

  async scan(
    cursor: string,
    _matchToken: 'MATCH',
    pattern: string,
    _countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]> {
    const matches = [...this.keys].filter((key) => redisGlob(pattern).test(key)).sort();
    const offset = Number(cursor);
    const next = offset + count;
    return [next >= matches.length ? '0' : String(next), matches.slice(offset, next)];
  }

  async unlink(...keys: string[]): Promise<number> {
    this.unlinks.push(keys);
    let removed = 0;
    for (const key of keys) {
      if (this.keys.delete(key)) removed += 1;
    }
    return removed;
  }
}

const SAMPLE_KEYS = [
  'Event:2627',
  'EventLiveSummary:2526:38',
  'PlayerValue:20260809',
  'Understat:Player:2526:abc',
  'LaunchNotification:happening:2627',
  'bull:data-sync:wait',
  'bull:understat-player-sync:wait',
  'gql:v2:2627:tournament:1',
  'player_state:history:v2:1',
  'PlayerValueMissing:20260809',
  'llm:v3:data:fpl:core:2627:active',
  'llm:v3:queue:coordination:mutation-lock:data-core',
  'unknown:must-survive',
] as const;

describe('cleanupLegacyRedisKeys', () => {
  test('defaults to dry-run and returns a deterministic exact-key manifest', async () => {
    const redis = new FakeRedis(SAMPLE_KEYS);
    const result = await cleanupLegacyRedisKeys(redis, { groups: ['dataCache'] });

    expect(result.dryRun).toBe(true);
    expect(result.keys).toEqual([
      'Event:2627',
      'EventLiveSummary:2526:38',
      'PlayerValue:20260809',
      'Understat:Player:2526:abc',
    ]);
    expect(result.keyManifestSha256).toHaveLength(64);
    expect(redis.unlinks).toEqual([]);
    expect(redis.keys.size).toBe(SAMPLE_KEYS.length);
  });

  test('unlinks only explicitly selected groups in bounded batches', async () => {
    const redis = new FakeRedis(SAMPLE_KEYS);
    const result = await cleanupLegacyRedisKeys(redis, {
      groups: ['dataCache', 'dataCoordination'],
      dryRun: false,
      unlinkBatchSize: 2,
    });

    expect(result.matchedKeys).toBe(5);
    expect(result.unlinkedKeys).toBe(5);
    expect(redis.unlinks.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(redis.keys.has('gql:v2:2627:tournament:1')).toBe(true);
    expect(redis.keys.has('bull:data-sync:wait')).toBe(true);
    expect(redis.keys.has('llm:v3:data:fpl:core:2627:active')).toBe(true);
    expect(redis.keys.has('unknown:must-survive')).toBe(true);
  });

  test('keeps GraphQL and legacy queue cleanup separately gated', async () => {
    const redis = new FakeRedis(SAMPLE_KEYS);
    const result = await cleanupLegacyRedisKeys(redis, {
      groups: ['graphqlCache', 'legacyQueueDb0'],
      dryRun: false,
    });

    expect(result.unlinkedKeys).toBe(5);
    expect(redis.keys.has('Event:2627')).toBe(true);
    expect(redis.keys.has('llm:v3:queue:coordination:mutation-lock:data-core')).toBe(true);
  });

  test('aborts before unlink when the matched-key safety bound is exceeded', async () => {
    const redis = new FakeRedis(SAMPLE_KEYS);
    await expect(
      cleanupLegacyRedisKeys(redis, {
        groups: ['dataCache'],
        dryRun: false,
        maxKeys: 3,
      }),
    ).rejects.toThrow('more than 3 keys');
    expect(redis.unlinks).toEqual([]);
    expect(redis.keys.size).toBe(SAMPLE_KEYS.length);
  });
});
