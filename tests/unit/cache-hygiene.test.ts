import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import { cache } from '../../src/cache/cache-operations';
import {
  getActiveCacheSeason,
  resetActiveSeasonMemo,
  setActiveCacheSeason,
} from '../../src/cache/cache-season';
import { parseHashEntries, parseHashValues } from '../../src/cache/hash-read';
import { redisSingleton } from '../../src/cache/singleton';
import { getCurrentSeason } from '../../src/utils/conditions';

// Direct method mutation + restore: bun's mock.module overwrites exports of
// already-loaded modules globally, leaking into other test files.
const originalGetClient = redisSingleton.getClient;
const originalMemoTtl = process.env.ACTIVE_SEASON_MEMO_TTL_MS;

function installFakeRedis(overrides: {
  get?: (key: string) => Promise<string | null>;
  set?: (key: string, value: string) => Promise<string>;
  setex?: (key: string, ttl: number, value: string) => Promise<string>;
}) {
  const fake = {
    get: mock(overrides.get ?? (async () => null)),
    set: mock(overrides.set ?? (async () => 'OK')),
    setex: mock(overrides.setex ?? (async () => 'OK')),
  };
  redisSingleton.getClient = async () => fake as never;
  return fake;
}

afterAll(() => {
  redisSingleton.getClient = originalGetClient;
  if (originalMemoTtl === undefined) {
    delete process.env.ACTIVE_SEASON_MEMO_TTL_MS;
  } else {
    process.env.ACTIVE_SEASON_MEMO_TTL_MS = originalMemoTtl;
  }
});

beforeEach(() => {
  resetActiveSeasonMemo();
  delete process.env.ACTIVE_SEASON_MEMO_TTL_MS;
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

  test('falls back to the calendar season on Redis errors without memoizing', async () => {
    const redis = installFakeRedis({
      get: async () => {
        throw new Error('redis down');
      },
    });
    expect(await getActiveCacheSeason()).toBe(getCurrentSeason());
    expect(await getActiveCacheSeason()).toBe(getCurrentSeason());
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  test('does not memoize invalid stored values', async () => {
    const redis = installFakeRedis({ get: async () => 'not-a-season' });
    expect(await getActiveCacheSeason()).toBe(getCurrentSeason());
    expect(await getActiveCacheSeason()).toBe(getCurrentSeason());
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  test('setActiveCacheSeason refreshes the memo on rollover', async () => {
    const redis = installFakeRedis({ get: async () => '2526' });
    expect(await setActiveCacheSeason('2627')).toBe(true);
    expect(redis.set).toHaveBeenCalledWith('Season:active', '2627');
    expect(await getActiveCacheSeason()).toBe('2627');
    // Only the pre-write read hit Redis; the memo served the getter.
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  test('skipped update re-arms the memo from Redis truth', async () => {
    const redis = installFakeRedis({ get: async () => '2627' });
    expect(await setActiveCacheSeason('2526')).toBe(false);
    expect(await getActiveCacheSeason()).toBe('2627');
    expect(redis.get).toHaveBeenCalledTimes(1);
  });
});
