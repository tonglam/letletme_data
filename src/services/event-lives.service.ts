import { eventLivesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import type { EventLive } from '../domain/event-lives';
import { eventLiveRepository } from '../repositories/event-lives';
import { eventLiveExplainsRepository } from '../repositories/event-live-explains';
import { transformEventLives } from '../transformers/event-lives';
import { transformEventLiveExplains } from '../transformers/event-live-explains';
import { logError, logInfo } from '../utils/logger';

/**
 * Event Lives Service - Business Logic Layer
 *
 * Handles all event live data operations:
 * - Data synchronization from FPL API
 * - Cache management
 * - Database operations
 * - Data retrieval with fallbacks
 */

/**
 * Get all event live data for a specific event (cache-first strategy: Redis → DB → update Redis)
 */
export async function getEventLivesByEventId(eventId: number): Promise<EventLive[]> {
  try {
    logInfo('Getting event live data by event ID', { eventId });

    // 1. Try cache first (fast path)
    const cached = await eventLivesCache.getByEventId(eventId);
    if (cached) {
      logInfo('Event lives retrieved from cache', { eventId, count: cached.length });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { eventId });
    const dbEventLives = await eventLiveRepository.findByEventId(eventId);

    // 3. Update cache for next time (async, don't block response)
    if (dbEventLives.length > 0) {
      eventLivesCache.set(eventId, dbEventLives).catch((error) => {
        logError('Failed to update event lives cache', error, { eventId });
      });
    }

    logInfo('Event lives retrieved from database', { eventId, count: dbEventLives.length });
    return dbEventLives;
  } catch (error) {
    logError('Failed to get event live data', error, { eventId });
    throw error;
  }
}

/**
 * Get event live data for a specific player in a specific event
 */
export async function getEventLiveByEventAndElement(
  eventId: number,
  elementId: number,
): Promise<EventLive | null> {
  try {
    logInfo('Getting event live data by event and element', { eventId, elementId });

    // 1. Try cache first (fast path)
    const cached = await eventLivesCache.getByEventAndElement(eventId, elementId);
    if (cached) {
      logInfo('Event live retrieved from cache', { eventId, elementId });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { eventId, elementId });
    const eventLive = await eventLiveRepository.findByEventAndElement(eventId, elementId);

    if (eventLive) {
      logInfo('Event live found in database', { eventId, elementId });
    } else {
      logInfo('Event live not found', { eventId, elementId });
    }

    return eventLive;
  } catch (error) {
    logError('Failed to get event live data', error, { eventId, elementId });
    throw error;
  }
}

/**
 * Get all event live data for a specific player across all events
 */
export async function getEventLivesByElementId(elementId: number): Promise<EventLive[]> {
  try {
    logInfo('Getting event live data by element ID', { elementId });

    // For this query, we go directly to the database as it's not commonly cached
    const eventLives = await eventLiveRepository.findByElementId(elementId);

    logInfo('Event lives retrieved from database', { elementId, count: eventLives.length });
    return eventLives;
  } catch (error) {
    logError('Failed to get event live data by element ID', error, { elementId });
    throw error;
  }
}

/**
 * Sync event live data from FPL API for a specific event
 */
export async function syncEventLives(eventId: number): Promise<{ count: number; errors: number }> {
  try {
    logInfo('Starting event live sync from FPL API', { eventId });

    // 1. Fetch from FPL API
    const liveData = await fplClient.getEventLive(eventId);

    if (!liveData.elements || !Array.isArray(liveData.elements)) {
      throw new Error('Invalid event live data from FPL API');
    }

    logInfo('Raw event live data fetched', { eventId, count: liveData.elements.length });

    // 2. Transform to domain EventLives and Explains
    const eventLives = transformEventLives(eventId, liveData.elements);
    const explains = transformEventLiveExplains(eventId, liveData.elements);
    logInfo('Event lives transformed', {
      eventId,
      total: liveData.elements.length,
      successful: eventLives.length,
      errors: liveData.elements.length - eventLives.length,
    });

    // 3. Save to database (batch upsert)
    const savedEventLives = await eventLiveRepository.upsertBatch(eventLives);
    logInfo('Event lives upserted to database', { eventId, count: savedEventLives.length });

    // 3b. Save explains to database (batch upsert)
    const savedExplains = await eventLiveExplainsRepository.upsertBatch(explains);
    logInfo('Event live explains upserted to database', { eventId, count: savedExplains.length });

    // 4. Update cache with full event live objects
    await eventLivesCache.set(eventId, savedEventLives);
    logInfo('Event lives cache updated', { eventId });

    const result = {
      count: savedEventLives.length,
      errors: liveData.elements.length - eventLives.length,
    };

    logInfo('Event live sync completed successfully', { eventId, ...result });
    return result;
  } catch (error) {
    logError('Event live sync failed', error, { eventId });
    throw error;
  }
}

/**
 * Clear event lives cache for a specific event
 */
export async function clearEventLivesCache(eventId: number): Promise<void> {
  try {
    logInfo('Clearing event lives cache', { eventId });
    await eventLivesCache.clearByEventId(eventId);
    logInfo('Event lives cache cleared', { eventId });
  } catch (error) {
    logError('Failed to clear event lives cache', error, { eventId });
    throw error;
  }
}

/**
 * Clear all event lives cache
 */
export async function clearAllEventLivesCache(): Promise<void> {
  try {
    logInfo('Clearing all event lives cache');
    await eventLivesCache.clear();
    logInfo('All event lives cache cleared');
  } catch (error) {
    logError('Failed to clear all event lives cache', error);
    throw error;
  }
}
