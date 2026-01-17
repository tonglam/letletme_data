import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { Event } from '../types';

async function loadEventsFromCache(): Promise<Event[] | null> {
  try {
    const redis = await redisSingleton.getClient();
    const key = `Event:${getCurrentSeason()}`;
    const hash = await redis.hgetall(key);

    if (!hash || Object.keys(hash).length === 0) {
      logDebug('Events cache miss');
      return null;
    }

    const events = Object.values(hash).map((value) => JSON.parse(value) as Event);
    logDebug('Events cache hit', { count: events.length });
    return events;
  } catch (error) {
    logError('Events cache load error', error);
    return null;
  }
}

// Domain-specific cache operations following Entity::season::field pattern
export const eventsCache = {
  // Get current event (filter from all events in memory - fast for 38 events)
  async getCurrent(): Promise<Event | null> {
    try {
      const allEvents = await loadEventsFromCache();
      if (!allEvents) {
        logDebug('Current event cache miss');
        return null;
      }

      const currentEvent = allEvents.find((e) => e.isCurrent);
      if (currentEvent) {
        logDebug('Current event cache hit', { id: currentEvent.id });
      }
      return currentEvent || null;
    } catch (error) {
      logError('Current event cache get error', error);
      return null;
    }
  },

  // Get next event (filter from all events in memory - fast for 38 events)
  async getNext(): Promise<Event | null> {
    try {
      const allEvents = await loadEventsFromCache();
      if (!allEvents) {
        logDebug('Next event cache miss');
        return null;
      }

      const nextEvent = allEvents.find((e) => e.isNext);
      if (nextEvent) {
        logDebug('Next event cache hit', { id: nextEvent.id });
      }
      return nextEvent || null;
    } catch (error) {
      logError('Next event cache get error', error);
      return null;
    }
  },

  // Store all events in a single hash (no duplication!)
  async set(events: Event[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Event:${season}`;

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash
      pipeline.del(key);

      if (events.length > 0) {
        // Store each event as a hash field (event ID -> full event JSON)
        const eventFields: Record<string, string> = {};
        for (const event of events) {
          eventFields[event.id.toString()] = JSON.stringify(event);
        }
        pipeline.hset(key, eventFields);
        pipeline.expire(key, CACHE_TTL.EVENTS);
      }

      await pipeline.exec();
      logDebug('Events cache updated (hash)', { count: events.length, season });
    } catch (error) {
      logError('Events cache set error', error);
      throw error;
    }
  },
};
