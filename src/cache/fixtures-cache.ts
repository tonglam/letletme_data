import type { Redis } from 'ioredis';

import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { Fixture } from '../types';

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    if (found.length > 0) {
      keys.push(...found);
    }
    cursor = nextCursor;
  } while (cursor !== '0');

  return keys;
}

export const fixturesCache = {
  async setByEvent(eventId: number, fixtures: Fixture[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Fixtures:${season}:${eventId}`;

      const pipeline = redis.pipeline();
      pipeline.del(key);

      if (fixtures.length > 0) {
        const fields: Record<string, string> = {};
        for (const fixture of fixtures) {
          fields[fixture.id.toString()] = JSON.stringify(fixture);
        }
        pipeline.hset(key, fields);
        pipeline.expire(key, CACHE_TTL.EVENTS);
      }

      await pipeline.exec();
      logDebug('Fixtures cache updated by event', { eventId, count: fixtures.length, season });
    } catch (error) {
      logError('Fixtures cache set by event error', error, { eventId });
      throw error;
    }
  },

  async set(fixtures: Fixture[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();

      const fixturesByEvent = new Map<number | string, Fixture[]>();
      const unscheduled: Fixture[] = [];

      for (const fixture of fixtures) {
        if (!fixture.event) {
          unscheduled.push(fixture);
        } else {
          if (!fixturesByEvent.has(fixture.event)) {
            fixturesByEvent.set(fixture.event, []);
          }
          fixturesByEvent.get(fixture.event)!.push(fixture);
        }
      }

      const pipeline = redis.pipeline();
      const pattern = `Fixtures:${season}:*`;
      const existingKeys = await scanKeys(redis, pattern);
      for (const key of existingKeys) {
        pipeline.del(key);
      }

      for (const [eventId, eventFixtures] of fixturesByEvent) {
        const key = `Fixtures:${season}:${eventId}`;
        const fields: Record<string, string> = {};
        for (const fixture of eventFixtures) {
          fields[fixture.id.toString()] = JSON.stringify(fixture);
        }
        pipeline.hset(key, fields);
        pipeline.expire(key, CACHE_TTL.EVENTS);
      }

      if (unscheduled.length > 0) {
        const key = `Fixtures:${season}:unscheduled`;
        const fields: Record<string, string> = {};
        for (const fixture of unscheduled) {
          fields[fixture.id.toString()] = JSON.stringify(fixture);
        }
        pipeline.hset(key, fields);
        pipeline.expire(key, CACHE_TTL.EVENTS);
      }

      await pipeline.exec();
      logDebug('Fixtures cache updated (all events)', {
        count: fixtures.length,
        scheduled: fixtures.length - unscheduled.length,
        unscheduled: unscheduled.length,
        events: fixturesByEvent.size,
        season,
      });
    } catch (error) {
      logError('Fixtures cache set error', error);
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const pattern = `Fixtures:${season}:*`;
      const keys = await scanKeys(redis, pattern);

      if (keys.length > 0) {
        await redis.del(...keys);
      }

      logDebug('Fixtures cache cleared', { season, keysCleared: keys.length });
    } catch (error) {
      logError('Fixtures cache clear error', error);
      throw error;
    }
  },

  async clearByEvent(eventId: number): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Fixtures:${season}:${eventId}`;
      await redis.del(key);
      logDebug('Fixtures cache cleared by event', { eventId, season });
    } catch (error) {
      logError('Fixtures cache clear by event error', error, { eventId });
      throw error;
    }
  },

  async clearUnscheduled(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Fixtures:${season}:unscheduled`;
      await redis.del(key);
      logDebug('Fixtures cache cleared for unscheduled', { season });
    } catch (error) {
      logError('Fixtures cache clear unscheduled error', error);
      throw error;
    }
  },
};
