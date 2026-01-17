import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError, logInfo } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { EventLive } from '../domain/event-lives';
import type { EventId } from '../types/base.type';

/**
 * Event Live Cache Operations
 * Pattern: EventLive:season:eventId -> hash of elementId -> EventLive data
 */
export const eventLivesCache = {
  /**
   * Get all event live data for a specific event
   */
  async getByEventId(eventId: EventId): Promise<EventLive[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLive:${getCurrentSeason()}:${eventId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Event lives cache miss', { eventId });
        return null;
      }

      const eventLives = Object.values(hash).map((value) => JSON.parse(value) as EventLive);
      logDebug('Event lives cache hit', { eventId, count: eventLives.length });
      return eventLives;
    } catch (error) {
      logError('Event lives cache get by event error', error, { eventId });
      return null;
    }
  },

  /**
   * Set event live data for an event (batch)
   */
  async set(eventId: EventId, eventLives: EventLive[]): Promise<void> {
    try {
      if (eventLives.length === 0) {
        logInfo('No event live data to cache', { eventId });
        return;
      }

      const redis = await redisSingleton.getClient();
      const key = `EventLive:${getCurrentSeason()}:${eventId}`;

      // Build hash: elementId -> EventLive data
      const hashData: Record<string, string> = {};
      for (const eventLive of eventLives) {
        hashData[eventLive.elementId.toString()] = JSON.stringify(eventLive);
      }

      // Clear existing hash and set new data
      await redis.del(key);
      await redis.hset(key, hashData);
      await redis.expire(key, CACHE_TTL.EVENT_LIVE);

      logInfo('Event lives cached', { eventId, count: eventLives.length });
    } catch (error) {
      logError('Event lives cache set error', error, { eventId, count: eventLives.length });
      throw error;
    }
  },
};
