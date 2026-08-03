import { getActiveCacheSeason } from './cache-season';
import { parseHashValues } from './hash-read';
import { replaceHashesUnlessLiveSnapshotOwned } from './live-snapshot-ownership';
import { logDebug, logError, logInfo } from '../utils/logger';
import { redisSingleton } from './singleton';

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
      const season = await getActiveCacheSeason();
      const key = `EventLive:${season}:${eventId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Event lives cache miss', { eventId });
        return null;
      }

      const eventLives = parseHashValues<EventLive>(hash, { key, eventId });
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
      const season = await getActiveCacheSeason();
      const key = `EventLive:${season}:${eventId}`;

      // Build hash: elementId -> EventLive data
      const hashData: Record<string, string> = {};
      for (const eventLive of eventLives) {
        hashData[eventLive.elementId.toString()] = JSON.stringify(eventLive);
      }

      const snapshotOwnedEventIds = await replaceHashesUnlessLiveSnapshotOwned(redis, season, [
        { eventId, key, fields: hashData },
      ]);
      if (snapshotOwnedEventIds.has(eventId)) {
        logInfo('Preserved snapshot-owned EventLive cache during compatibility write', {
          eventId,
          season,
        });
      } else {
        logInfo('Event lives cached', { eventId, season, count: eventLives.length });
      }
    } catch (error) {
      logError('Event lives cache set error', error, { eventId, count: eventLives.length });
      throw error;
    }
  },
};
