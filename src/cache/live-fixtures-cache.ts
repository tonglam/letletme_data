import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError, logInfo } from '../utils/logger';
import { redisSingleton } from './singleton';

import type { EventId } from '../types/base.type';
import type { LiveFixturesByTeam } from '../domain/live-fixtures';

/**
 * Live Fixture Cache Operations
 *
 * Pattern: LiveFixture:season:eventId -> hash of teamId -> LiveFixtureByStatus JSON
 *
 * Cache-only: delete-before-insert, TTL -1 (no expiration) by default.
 */
export const liveFixturesCache = {
  async set(eventId: EventId, byTeam: LiveFixturesByTeam): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `LiveFixture:${season}:${eventId}`;

      const pipeline = redis.pipeline();
      pipeline.del(key);

      const teamIds = Object.keys(byTeam);
      if (teamIds.length > 0) {
        const fields: Record<string, string> = {};
        for (const teamId of teamIds) {
          fields[teamId] = JSON.stringify(byTeam[teamId]);
        }
        pipeline.hset(key, fields);
      }

      await pipeline.exec();
      logInfo('Live fixtures cache updated', { eventId, season, teams: teamIds.length });
    } catch (error) {
      logError('Live fixtures cache set error', error, { eventId });
      throw error;
    }
  },

  async get(eventId: EventId): Promise<LiveFixturesByTeam | null> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `LiveFixture:${season}:${eventId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Live fixtures cache miss', { eventId, season });
        return null;
      }

      const byTeam: Record<string, unknown> = {};
      for (const [teamId, value] of Object.entries(hash)) {
        byTeam[teamId] = JSON.parse(value);
      }

      logDebug('Live fixtures cache hit', { eventId, season, teams: Object.keys(byTeam).length });
      return byTeam as LiveFixturesByTeam;
    } catch (error) {
      logError('Live fixtures cache get error', error, { eventId });
      return null;
    }
  },

  async clear(eventId: EventId): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `LiveFixture:${season}:${eventId}`;
      await redis.del(key);
      logInfo('Live fixtures cache cleared', { eventId, season });
    } catch (error) {
      logError('Live fixtures cache clear error', error, { eventId });
      throw error;
    }
  },
};
