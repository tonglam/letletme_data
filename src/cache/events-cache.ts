import { selectCurrentEventByDeadline, selectNextEventByDeadline } from '../domain/events';
import { logDebug, logError, logInfo } from '../utils/logger';
import { finalizeSeasonCacheWrite, getActiveCacheSeason } from './cache-season';
import { redisSingleton } from './singleton';

import type { Event } from '../types';

function normalizeDeadlineTime(event: Event): string | null {
  if (typeof event.deadlineTime === 'string' && event.deadlineTime.length > 0) {
    return event.deadlineTime;
  }
  if (event.deadlineTimeEpoch) {
    return new Date(event.deadlineTimeEpoch * 1000).toISOString();
  }
  return null;
}

function serializeEvent(event: Event): string {
  return JSON.stringify({
    ...event,
    deadlineTime: normalizeDeadlineTime(event),
  });
}

async function loadEventsFromCache(): Promise<Event[] | null> {
  try {
    const redis = await redisSingleton.getClient();
    const season = await getActiveCacheSeason();
    const key = `Event:${season}`;
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

async function getNeighbourEvent(offset: number, label: string): Promise<Event | null> {
  try {
    const current = await eventsCache.getCurrent();
    const redis = await redisSingleton.getClient();
    const season = await getActiveCacheSeason();

    if (!current && offset === 1) {
      const allEvents = await loadEventsFromCache();
      if (!allEvents) {
        logDebug(`${label} event cache miss - no current event`);
        return null;
      }
      const nextEvent = selectNextEventByDeadline(allEvents);
      if (nextEvent) {
        logDebug(`${label} event cache hit (pre-current fallback)`, { id: nextEvent.id });
      }
      return nextEvent;
    }

    if (!current) {
      logDebug(`${label} event cache miss - no current event`);
      return null;
    }
    const targetId = current.id + offset;
    if (targetId < 1 || targetId > 38) {
      logDebug(`${label} event out of range`, { targetId });
      return null;
    }
    const value = await redis.hget(`Event:${season}`, targetId.toString());
    if (!value) {
      logDebug(`${label} event cache miss`, { targetId });
      return null;
    }
    const event = JSON.parse(value) as Event;
    logDebug(`${label} event cache hit`, { id: event.id });
    return event;
  } catch (error) {
    logError(`${label} event cache get error`, error);
    return null;
  }
}

// Domain-specific cache operations following Entity::season::field pattern
export const eventsCache = {
  async getCurrent(): Promise<Event | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = 'event:current';
      const value = await redis.get(key);
      if (value) {
        logDebug('Current event cache hit (dedicated key)');
        return JSON.parse(value) as Event;
      }
      // Fallback: derive from full hash using deadline-based logic
      const allEvents = await loadEventsFromCache();
      if (!allEvents) {
        logDebug('Current event cache miss');
        return null;
      }
      const currentEvent = selectCurrentEventByDeadline(allEvents);
      if (currentEvent) {
        logDebug('Current event cache hit (hash fallback)', { id: currentEvent.id });
      }
      return currentEvent;
    } catch (error) {
      logError('Current event cache get error', error);
      return null;
    }
  },

  // Next event = current event id + 1 (derived, not from FPL's lagging is_next flag)
  async getNext(): Promise<Event | null> {
    return getNeighbourEvent(1, 'Next');
  },

  // Previous event = current event id - 1 (derived, not from FPL's is_previous flag)
  async getPrevious(): Promise<Event | null> {
    return getNeighbourEvent(-1, 'Previous');
  },

  async refreshCurrent(): Promise<boolean> {
    try {
      const allEvents = await loadEventsFromCache();
      if (!allEvents) return false;

      const derived = selectCurrentEventByDeadline(allEvents);
      if (!derived) return false;

      const redis = await redisSingleton.getClient();
      const current = await redis.get('event:current');

      if (current) {
        const cached = JSON.parse(current) as Event;
        if (cached.id === derived.id) return false;
      }

      await redis.set('event:current', serializeEvent(derived));
      logInfo('event:current refreshed', {
        previousId: current ? (JSON.parse(current) as Event).id : null,
        newId: derived.id,
      });
      return true;
    } catch (error) {
      logError('event:current refresh error', error);
      return false;
    }
  },

  // Store all events in a single hash (no duplication!)
  async set(events: Event[], season?: string): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const activeSeason = season ?? (await getActiveCacheSeason());
      const key = `Event:${activeSeason}`;

      const currentEventKey = 'event:current';
      const currentEvent = selectCurrentEventByDeadline(events);

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash
      pipeline.del(key);

      if (events.length > 0) {
        // Store each event as a hash field (event ID -> full event JSON)
        const eventFields: Record<string, string> = {};
        for (const event of events) {
          eventFields[event.id.toString()] = serializeEvent(event);
        }
        pipeline.hset(key, eventFields);
      }

      if (currentEvent) {
        pipeline.set(currentEventKey, serializeEvent(currentEvent));
      } else {
        pipeline.del(currentEventKey);
      }

      await pipeline.exec();
      await finalizeSeasonCacheWrite(activeSeason, ['Event']);
      logDebug('Events cache updated (hash)', { count: events.length, season: activeSeason });
    } catch (error) {
      logError('Events cache set error', error);
      throw error;
    }
  },
};
