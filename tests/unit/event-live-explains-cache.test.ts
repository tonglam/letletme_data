import { describe, expect, test } from 'bun:test';
import type Redis from 'ioredis';

import { createEventLiveExplainCache } from '../../src/cache/event-live-explains-cache';
import { transformedExplainsFixture } from '../fixtures/event-live-explains.fixtures';

function createFakeRedis() {
  const hashes = new Map<string, Map<string, string>>();

  const del = async (...keys: string[]): Promise<number> => {
    let deleted = 0;
    for (const key of keys) deleted += Number(hashes.delete(key));
    return deleted;
  };
  const hset = async (key: string, entries: Record<string, string>): Promise<number> => {
    const hash = hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(entries)) hash.set(field, value);
    hashes.set(key, hash);
    return Object.keys(entries).length;
  };
  const redis = {
    hashes,
    hgetall: async (key: string): Promise<Record<string, string>> =>
      Object.fromEntries(hashes.get(key) ?? []),
    del,
    hset,
    multi: () => {
      const commands: Array<() => Promise<unknown>> = [];
      const chain = {
        del: (...keys: string[]) => {
          commands.push(() => del(...keys));
          return chain;
        },
        hset: (key: string, entries: Record<string, string>) => {
          commands.push(() => hset(key, entries));
          return chain;
        },
        exec: async (): Promise<Array<[null, unknown]>> => {
          const results: Array<[null, unknown]> = [];
          for (const command of commands) results.push([null, await command()]);
          return results;
        },
      };
      return chain;
    },
  };
  return redis;
}

function cacheWith(redis: ReturnType<typeof createFakeRedis>) {
  return createEventLiveExplainCache({
    getRedisClient: async () => redis as unknown as Redis,
    getSeason: async () => '2526',
  });
}

describe('event live explain additive cache contract', () => {
  test('keeps the legacy JSON shape frozen and publishes the complete V2 shape atomically', async () => {
    const redis = createFakeRedis();
    await cacheWith(redis).set(99, transformedExplainsFixture);

    const legacy = JSON.parse(redis.hashes.get('EventLiveExplain:2526:99')!.get('101')!);
    const v2 = JSON.parse(redis.hashes.get('EventLiveExplainV2:2526:99')!.get('101')!);

    expect(Object.keys(legacy)).toEqual([
      'eventId',
      'elementId',
      'bonus',
      'minutes',
      'minutesPoints',
      'goalsScored',
      'goalsScoredPoints',
      'assists',
      'assistsPoints',
      'cleanSheets',
      'cleanSheetsPoints',
      'goalsConceded',
      'goalsConcededPoints',
      'ownGoals',
      'ownGoalsPoints',
      'penaltiesSaved',
      'penaltiesSavedPoints',
      'penaltiesMissed',
      'penaltiesMissedPoints',
      'yellowCards',
      'yellowCardsPoints',
      'redCards',
      'redCardsPoints',
      'saves',
      'savesPoints',
    ]);
    expect(v2.defensiveContribution).toBe(10);
    expect(v2.defensiveContributionPoints).toBe(2);
  });

  test('prefers valid V2 values and falls back per player to normalized legacy values', async () => {
    const redis = createFakeRedis();
    const cache = cacheWith(redis);
    await cache.set(99, transformedExplainsFixture);

    const preferred = await cache.getByEventId(99);
    expect(preferred?.find((explain) => explain.elementId === 101)?.defensiveContribution).toBe(10);

    redis.hashes.get('EventLiveExplainV2:2526:99')!.set('101', '{corrupt');
    const fallback = await cache.getByEventId(99);
    expect(fallback?.find((explain) => explain.elementId === 101)).toMatchObject({
      defensiveContribution: null,
      defensiveContributionPoints: null,
    });
    expect(fallback?.find((explain) => explain.elementId === 102)?.defensiveContribution).toBe(0);
  });

  test('clears both versions for an event', async () => {
    const redis = createFakeRedis();
    const cache = cacheWith(redis);
    await cache.set(99, transformedExplainsFixture);
    await cache.clearByEventId(99);

    expect(redis.hashes.has('EventLiveExplain:2526:99')).toBe(false);
    expect(redis.hashes.has('EventLiveExplainV2:2526:99')).toBe(false);
  });
});
