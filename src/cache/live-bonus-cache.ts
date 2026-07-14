import { getActiveCacheSeason } from './cache-season';
import { logDebug, logError, logInfo } from '../utils/logger';
import { redisSingleton } from './singleton';

import type { EventId } from '../types/base.type';
import type { LiveBonusByTeam } from '../domain/live-bonus';

/**
 * Live Bonus Cache Operations
 *
 * Pattern: LiveBonus:season:eventId -> hash of teamId -> {elementId: bonus} JSON
 *
 * Cache-only: delete-before-insert, TTL -1 (no expiration) by default.
 */
export const liveBonusCache = {
  async set(eventId: EventId, byTeam: LiveBonusByTeam): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const key = `LiveBonus:${season}:${eventId}`;

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
      logInfo('Live bonus cache updated', { eventId, season, teams: teamIds.length });
    } catch (error) {
      logError('Live bonus cache set error', error, { eventId });
      throw error;
    }
  },

  async get(eventId: EventId): Promise<LiveBonusByTeam | null> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const key = `LiveBonus:${season}:${eventId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Live bonus cache miss', { eventId, season });
        return null;
      }

      const byTeam: Record<string, Record<string, number>> = {};
      for (const [teamId, value] of Object.entries(hash)) {
        byTeam[teamId] = JSON.parse(value);
      }

      logDebug('Live bonus cache hit', { eventId, season, teams: Object.keys(byTeam).length });
      return byTeam as LiveBonusByTeam;
    } catch (error) {
      logError('Live bonus cache get error', error, { eventId });
      return null;
    }
  },

  async clear(eventId: EventId): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const key = `LiveBonus:${season}:${eventId}`;
      await redis.del(key);
      logInfo('Live bonus cache cleared', { eventId, season });
    } catch (error) {
      logError('Live bonus cache clear error', error, { eventId });
      throw error;
    }
  },
};
