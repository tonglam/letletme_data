import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError, logInfo } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { EventLiveExplain } from '../domain/event-live-explains';
import type { EventId } from '../types/base.type';

/**
 * Event Live Explain Cache Operations
 * Pattern: EventLiveExplain:season:eventId -> hash of elementId -> explain data
 */
export const eventLiveExplainCache = {
  async getByEventId(eventId: EventId): Promise<EventLiveExplain[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLiveExplain:${getCurrentSeason()}:${eventId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Event live explain cache miss', { eventId });
        return null;
      }

      const explains = Object.values(hash).map((value) => JSON.parse(value) as EventLiveExplain);
      logDebug('Event live explain cache hit', { eventId, count: explains.length });
      return explains;
    } catch (error) {
      logError('Event live explain cache get error', error, { eventId });
      return null;
    }
  },

  async set(eventId: EventId, explains: EventLiveExplain[]): Promise<void> {
    try {
      if (explains.length === 0) {
        logInfo('No event live explain data to cache', { eventId });
        return;
      }

      const redis = await redisSingleton.getClient();
      const key = `EventLiveExplain:${getCurrentSeason()}:${eventId}`;

      const hashData: Record<string, string> = {};
      for (const explain of explains) {
        hashData[explain.elementId.toString()] = JSON.stringify(explain);
      }

      await redis.del(key);
      await redis.hset(key, hashData);
      await redis.expire(key, CACHE_TTL.EVENT_LIVE_EXPLAIN);

      logInfo('Event live explains cached', { eventId, count: explains.length });
    } catch (error) {
      logError('Event live explain cache set error', error, { eventId, count: explains.length });
      throw error;
    }
  },

  async clearByEventId(eventId: EventId): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLiveExplain:${getCurrentSeason()}:${eventId}`;
      await redis.del(key);

      logInfo('Event live explain cache cleared', { eventId });
    } catch (error) {
      logError('Failed to clear event live explain cache', error, { eventId });
      throw error;
    }
  },
};
