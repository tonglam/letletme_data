import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError, logInfo } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { EventStanding } from '../types';
import type { EventId } from '../types/base.type';

/**
 * Event Standings Cache Operations
 * Pattern: EventStandings:season:eventId -> hash of teamId -> standing data
 */
export const eventStandingsCache = {
  async getByEventId(eventId: EventId): Promise<EventStanding[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventStandings:${getCurrentSeason()}:${eventId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Event standings cache miss', { eventId });
        return null;
      }

      const standings = Object.values(hash).map((value) => JSON.parse(value) as EventStanding);
      standings.sort((a, b) => a.position - b.position);
      logDebug('Event standings cache hit', { eventId, count: standings.length });
      return standings;
    } catch (error) {
      logError('Event standings cache get error', error, { eventId });
      return null;
    }
  },

  async set(eventId: EventId, standings: EventStanding[]): Promise<void> {
    try {
      if (standings.length === 0) {
        logInfo('No event standings to cache', { eventId });
        return;
      }

      const redis = await redisSingleton.getClient();
      const key = `EventStandings:${getCurrentSeason()}:${eventId}`;

      const hashData: Record<string, string> = {};
      for (const standing of standings) {
        hashData[standing.teamId.toString()] = JSON.stringify(standing);
      }

      await redis.del(key);
      await redis.hset(key, hashData);
      await redis.expire(key, CACHE_TTL.EVENT_STANDINGS);

      logInfo('Event standings cached', { eventId, count: standings.length });
    } catch (error) {
      logError('Event standings cache set error', error, { eventId, count: standings.length });
      throw error;
    }
  },

  async clearByEventId(eventId: EventId): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventStandings:${getCurrentSeason()}:${eventId}`;
      await redis.del(key);

      logInfo('Event standings cache cleared', { eventId });
    } catch (error) {
      logError('Failed to clear event standings cache', error, { eventId });
      throw error;
    }
  },
};
