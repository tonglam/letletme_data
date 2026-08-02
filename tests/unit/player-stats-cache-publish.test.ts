import { describe, expect, test } from 'bun:test';

import { resetActiveSeasonMemo } from '../../src/cache/cache-season';
import { createPlayerStatsHashCache } from '../../src/cache/player-stats-cache';
import { redisSingleton } from '../../src/cache/singleton';
import { CacheError } from '../../src/utils/errors';
import { generatePlayerStat } from '../fixtures/player-stats.fixtures';

describe('player-stats latest-view publication', () => {
  test('stages and atomically renames a complete hash over the previous view', async () => {
    const originalGetClient = redisSingleton.getClient;
    const hashes = new Map<string, Map<string, string>>([
      ['PlayerStat:2627', new Map([['99', JSON.stringify({ eventId: 0, elementId: 99 })]])],
    ]);
    const operations: string[] = [];
    const fakeRedis = {
      get: async (key: string) => (key === 'Season:active' ? '2627' : null),
      hset: async (key: string, entries: Record<string, string>) => {
        operations.push(`hset:${key}`);
        hashes.set(key, new Map(Object.entries(entries)));
        return Object.keys(entries).length;
      },
      hlen: async (key: string) => hashes.get(key)?.size ?? 0,
      rename: async (source: string, destination: string) => {
        operations.push(`rename:${source}:${destination}`);
        const staged = hashes.get(source);
        if (!staged) throw new Error('missing staging hash');
        hashes.set(destination, staged);
        hashes.delete(source);
        return 'OK';
      },
      del: async (key: string) => {
        operations.push(`del:${key}`);
        return Number(hashes.delete(key));
      },
    };
    redisSingleton.getClient = async () => fakeRedis as never;
    resetActiveSeasonMemo();

    try {
      const stats = [
        generatePlayerStat({ eventId: 1, elementId: 1 }),
        generatePlayerStat({ eventId: 1, elementId: 2 }),
      ];
      await createPlayerStatsHashCache().setPlayerStatsByEvent(1, stats);
    } finally {
      redisSingleton.getClient = originalGetClient;
      resetActiveSeasonMemo();
    }

    expect(Array.from(hashes.get('PlayerStat:2627')?.keys() ?? [])).toEqual(['1', '2']);
    expect(operations[0]).toStartWith('hset:PlayerStat:2627:staging:');
    expect(operations[1]).toStartWith('rename:PlayerStat:2627:staging:');
    expect(operations[1]).toEndWith(':PlayerStat:2627');
    expect(operations.some((operation) => operation.startsWith('del:'))).toBe(false);
  });

  test('keeps the previous complete view when staging fails', async () => {
    const originalGetClient = redisSingleton.getClient;
    const oldValue = JSON.stringify({ eventId: 1, elementId: 99 });
    const hashes = new Map<string, Map<string, string>>([
      ['PlayerStat:2627', new Map([['99', oldValue]])],
    ]);
    const fakeRedis = {
      get: async (key: string) => (key === 'Season:active' ? '2627' : null),
      hset: async () => {
        throw new Error('OOM');
      },
      del: async (key: string) => Number(hashes.delete(key)),
    };
    redisSingleton.getClient = async () => fakeRedis as never;
    resetActiveSeasonMemo();

    try {
      await expect(
        createPlayerStatsHashCache().setPlayerStatsByEvent(1, [
          generatePlayerStat({ eventId: 1, elementId: 1 }),
        ]),
      ).rejects.toBeInstanceOf(CacheError);
    } finally {
      redisSingleton.getClient = originalGetClient;
      resetActiveSeasonMemo();
    }

    expect(hashes.get('PlayerStat:2627')?.get('99')).toBe(oldValue);
  });

  test('refuses an empty latest view', async () => {
    await expect(createPlayerStatsHashCache().setPlayerStatsByEvent(1, [])).rejects.toBeInstanceOf(
      CacheError,
    );
  });
});
