import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError, logInfo } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { EventLiveSummary } from '../domain/event-live-summaries';
import type { EventId } from '../types/base.type';

/**
 * Event Live Summary Cache Operations
 * Pattern: EventLiveSummary:season:eventId -> hash of elementId -> summary data
 */
export const eventLiveSummaryCache = {
  async getByEventId(eventId: EventId): Promise<EventLiveSummary[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLiveSummary:${getCurrentSeason()}:${eventId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Event live summary cache miss', { eventId });
        return null;
      }

      const summaries = Object.values(hash).map((value) => JSON.parse(value) as EventLiveSummary);
      logDebug('Event live summary cache hit', { eventId, count: summaries.length });
      return summaries;
    } catch (error) {
      logError('Event live summary cache get error', error, { eventId });
      return null;
    }
  },

  async set(eventId: EventId, summaries: EventLiveSummary[]): Promise<void> {
    try {
      if (summaries.length === 0) {
        logInfo('No event live summary data to cache', { eventId });
        return;
      }

      const redis = await redisSingleton.getClient();
      const key = `EventLiveSummary:${getCurrentSeason()}:${eventId}`;

      const hashData: Record<string, string> = {};
      for (const summary of summaries) {
        hashData[summary.elementId.toString()] = JSON.stringify(summary);
      }

      await redis.del(key);
      await redis.hset(key, hashData);
      await redis.expire(key, CACHE_TTL.EVENT_LIVE_SUMMARY);

      logInfo('Event live summaries cached', { eventId, count: summaries.length });
    } catch (error) {
      logError('Event live summary cache set error', error, { eventId, count: summaries.length });
      throw error;
    }
  },

  async clearByEventId(eventId: EventId): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLiveSummary:${getCurrentSeason()}:${eventId}`;
      await redis.del(key);

      logInfo('Event live summary cache cleared', { eventId });
    } catch (error) {
      logError('Failed to clear event live summary cache', error, { eventId });
      throw error;
    }
  },
};
