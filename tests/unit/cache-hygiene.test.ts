import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import { cache } from '../../src/cache/cache-operations';
import {
  clearStaleSeasonCache,
  finalizeSeasonCacheWrite,
  getActiveCacheSeason,
  getActiveCacheSeasonUncached,
  readStoredActiveCacheSeason,
  rememberCoreSnapshotActiveSeason,
  resetActiveSeasonMemo,
  SEASON_CACHE_PREFIXES,
  withActiveSeasonWriteFence,
} from '../../src/cache/cache-season';
import { parseHashEntries, parseHashValues } from '../../src/cache/hash-read';
import { redisSingleton } from '../../src/cache/singleton';
import { databaseSingleton } from '../../src/db/singleton';

// Direct method mutation + restore: bun's mock.module overwrites exports of
// already-loaded modules globally, leaking into other test files.
const originalGetClient = redisSingleton.getClient;
const originalGetDb = databaseSingleton.getDb;
const originalMemoTtl = process.env.ACTIVE_SEASON_MEMO_TTL_MS;
const seasonFenceExecute = mock(async () => []);

function installFakeRedis(overrides: {
  get?: (key: string) => Promise<string | null>;
  set?: (key: string, value: string) => Promise<string>;
  setex?: (key: string, ttl: number, value: string) => Promise<string>;
  scan?: (...args: Array<string | number>) => Promise<[string, string[]]>;
  del?: (...keys: string[]) => Promise<number>;
}) {
  const fake = {
    get: mock(overrides.get ?? (async () => null)),
    set: mock(overrides.set ?? (async () => 'OK')),
    setex: mock(overrides.setex ?? (async () => 'OK')),
    scan: mock(overrides.scan ?? (async () => ['0', []])),
    del: mock(overrides.del ?? (async () => 0)),
  };
  redisSingleton.getClient = async () => fake as never;
  return fake;
}

afterAll(() => {
  redisSingleton.getClient = originalGetClient;
  databaseSingleton.getDb = originalGetDb;
  if (originalMemoTtl === undefined) {
    delete process.env.ACTIVE_SEASON_MEMO_TTL_MS;
  } else {
    process.env.ACTIVE_SEASON_MEMO_TTL_MS = originalMemoTtl;
  }
});

beforeEach(() => {
  resetActiveSeasonMemo();
  delete process.env.ACTIVE_SEASON_MEMO_TTL_MS;
  seasonFenceExecute.mockClear();
  databaseSingleton.getDb = async () =>
    ({
      transaction: async (operation: (tx: { execute: typeof seasonFenceExecute }) => unknown) =>
        operation({ execute: seasonFenceExecute }),
    }) as never;
});

describe('cache-operations.set TTL semantics', () => {
  test('writes plain SET when no ttl is given', async () => {
    const redis = installFakeRedis({});
    await cache.set('foo', { a: 1 });
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.setex).not.toHaveBeenCalled();
    expect(redis.set.mock.calls[0][0]).toBe('letletme:foo');
    expect(JSON.parse(redis.set.mock.calls[0][1])).toEqual({ a: 1 });
  });

  test('writes plain SET for non-positive ttl', async () => {
    const redis = installFakeRedis({});
    await cache.set('zero', 1, 0);
    await cache.set('negative', 1, -5);
    expect(redis.set).toHaveBeenCalledTimes(2);
    expect(redis.setex).not.toHaveBeenCalled();
  });

  test('writes SETEX only for a positive ttl', async () => {
    const redis = installFakeRedis({});
    await cache.set('marker', { ranAt: 'x' }, 120);
    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(redis.setex.mock.calls[0]).toEqual([
      'letletme:marker',
      120,
      JSON.stringify({ ranAt: 'x' }),
    ]);
    expect(redis.set).not.toHaveBeenCalled();
  });
});

describe('hash-read helpers', () => {
  test('parseHashValues returns parsed values and skips corrupt fields', () => {
    const hash = {
      '1': JSON.stringify({ id: 1 }),
      broken: '{not-json',
      '2': JSON.stringify({ id: 2 }),
    };
    expect(parseHashValues<{ id: number }>(hash, { key: 'K' })).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('parseHashEntries preserves field names and skips corrupt fields', () => {
    const hash = { '7': JSON.stringify({ v: 'a' }), bad: 'nope' };
    expect(parseHashEntries<{ v: string }>(hash, {})).toEqual([['7', { v: 'a' }]]);
  });

  test('empty hash yields empty results', () => {
    expect(parseHashValues({}, {})).toEqual([]);
    expect(parseHashEntries({}, {})).toEqual([]);
  });
});

describe('getActiveCacheSeason memo', () => {
  test('serves repeat reads from the memo without hitting Redis again', async () => {
    const redis = installFakeRedis({ get: async () => '2526' });
    expect(await getActiveCacheSeason()).toBe('2526');
    expect(await getActiveCacheSeason()).toBe('2526');
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  test('re-reads Redis after the memo expires', async () => {
    process.env.ACTIVE_SEASON_MEMO_TTL_MS = '1';
    const redis = installFakeRedis({ get: async () => '2526' });
    expect(await getActiveCacheSeason()).toBe('2526');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await getActiveCacheSeason()).toBe('2526');
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  test('memo ttl 0 disables memoization', async () => {
    process.env.ACTIVE_SEASON_MEMO_TTL_MS = '0';
    const redis = installFakeRedis({ get: async () => '2526' });
    expect(await getActiveCacheSeason()).toBe('2526');
    expect(await getActiveCacheSeason()).toBe('2526');
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  test('authoritative reads bypass a still-valid process memo', async () => {
    let activeSeason = '2526';
    const redis = installFakeRedis({ get: async () => activeSeason });
    expect(await getActiveCacheSeason()).toBe('2526');
    activeSeason = '2627';
    expect(await getActiveCacheSeason()).toBe('2526');
    expect(await getActiveCacheSeasonUncached()).toBe('2627');
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  test('rejects Redis errors without memoizing', async () => {
    const redis = installFakeRedis({
      get: async () => {
        throw new Error('redis down');
      },
    });
    await expect(getActiveCacheSeason()).rejects.toThrow('redis down');
    await expect(getActiveCacheSeason()).rejects.toThrow('redis down');
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  test('rejects and does not memoize invalid stored values', async () => {
    const redis = installFakeRedis({ get: async () => 'not-a-season' });
    await expect(getActiveCacheSeason()).rejects.toThrow('Season:active is missing or malformed');
    await expect(getActiveCacheSeason()).rejects.toThrow('Season:active is missing or malformed');
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  test('core snapshot publication refreshes the memo after its Redis transaction', async () => {
    const redis = installFakeRedis({ get: async () => '2627' });
    rememberCoreSnapshotActiveSeason('2627');
    expect(await getActiveCacheSeason()).toBe('2627');
    expect(redis.get).not.toHaveBeenCalled();
  });

  test('raw active-season reads return null for missing or malformed values', async () => {
    const redis = installFakeRedis({ get: async () => 'bad' });
    expect(await readStoredActiveCacheSeason()).toBeNull();
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  test('runs active-season authority changes behind the exclusive database fence', async () => {
    const isolatedDb = {
      transaction: async (operation: (tx: { execute: typeof seasonFenceExecute }) => unknown) =>
        operation({ execute: seasonFenceExecute }),
    } as never;
    await expect(withActiveSeasonWriteFence(async () => 'done', isolatedDb)).resolves.toBe('done');
    expect(seasonFenceExecute).toHaveBeenCalledTimes(1);
  });
});

describe('season rollover cleanup', () => {
  test('covers every durable season cache family', () => {
    expect(SEASON_CACHE_PREFIXES).toEqual([
      'Event',
      'Team',
      'Player',
      'Phase',
      'Fixtures',
      'FixturesByTeam',
      'EventLive',
      'EventLiveSummary',
      'EventLiveExplain',
      'EventLiveExplainV2',
      'LiveFixture',
      'LiveFixtureV2',
      'LiveBonus',
      'LiveBonusV2',
      'LiveSnapshotMeta',
      'EventOverallResult',
      'EntryInfo',
      'PlayerStat',
    ]);
  });

  test('deletes stale families while preserving exact current-season keys', async () => {
    const staleKeys = SEASON_CACHE_PREFIXES.map((prefix) => `${prefix}:2526`);
    const currentKeys = SEASON_CACHE_PREFIXES.map((prefix) => `${prefix}:2627`);
    const keys = [...staleKeys, ...currentKeys, 'Event:2627:1', 'Event:26270', 'PlayerValue:2526'];
    const redis = installFakeRedis({
      scan: async (...args) => {
        const pattern = String(args[2]);
        const prefix = pattern.slice(0, -1);
        return ['0', keys.filter((key) => key.startsWith(prefix))];
      },
      del: async (...deletedKeys) => deletedKeys.length,
    });

    await clearStaleSeasonCache('2627');

    expect(redis.scan).toHaveBeenCalledTimes(SEASON_CACHE_PREFIXES.length);
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(new Set(redis.del.mock.calls[0])).toEqual(new Set([...staleKeys, 'Event:26270']));
    expect(redis.del.mock.calls[0]).not.toContain('Event:2627');
    expect(redis.del.mock.calls[0]).not.toContain('Event:2627:1');
    expect(redis.del.mock.calls[0]).not.toContain('PlayerValue:2526');
  });

  test('partial writers can publish only into the already active season', async () => {
    const redis = installFakeRedis({
      get: async () => '2526',
    });

    await expect(finalizeSeasonCacheWrite('2627', ['Event'])).rejects.toThrow(
      'Core snapshot required',
    );
    await expect(finalizeSeasonCacheWrite('2526', ['Event'])).resolves.toBeUndefined();

    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.scan).not.toHaveBeenCalled();
  });
});
