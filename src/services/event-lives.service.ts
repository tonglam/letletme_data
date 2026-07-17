import { eventLivesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { getDb } from '../db/singleton';
import type { EventLive } from '../domain/event-lives';
import { createEventLiveExplainsRepository } from '../repositories/event-live-explains';
import { createEventLiveRepository, eventLiveRepository } from '../repositories/event-lives';
import { transformEventLiveExplains } from '../transformers/event-live-explains';
import { transformEventLives } from '../transformers/event-lives';
import { logDebug, logError, logInfo } from '../utils/logger';

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
    const cached = await eventLivesCache.getByEventId(eventId);
    if (cached) {
      logDebug('Event lives retrieved from cache', { eventId, count: cached.length });
      return cached;
    }

    logDebug('Event lives cache miss - fetching from database', { eventId });
    const dbEventLives = await eventLiveRepository.findByEventId(eventId);

    if (dbEventLives.length > 0) {
      eventLivesCache.set(eventId, dbEventLives).catch((error) => {
        logError('Failed to update event lives cache', error, { eventId });
      });
    }

    logDebug('Event lives retrieved from database', { eventId, count: dbEventLives.length });
    return dbEventLives;
  } catch (error) {
    logError('Failed to get event live data', error, { eventId });
    throw error;
  }
}

/**
 * Fast cache-only update for real-time match data (runs every 1 minute)
 * Skips database persistence for performance
 */
export async function updateEventLivesCache(eventId: number): Promise<{ count: number }> {
  try {
    logInfo('Starting fast cache update', { eventId });

    const liveData = await fplClient.getEventLive(eventId);

    if (!liveData.elements || !Array.isArray(liveData.elements)) {
      throw new Error('Invalid event live data from FPL API');
    }

    const eventLives = transformEventLives(eventId, liveData.elements);
    logDebug('Event lives transformed for cache', { eventId, count: eventLives.length });

    await eventLivesCache.set(eventId, eventLives);
    logInfo('Cache update completed', { eventId, count: eventLives.length });

    return { count: eventLives.length };
  } catch (error) {
    logError('Cache update failed', error, { eventId });
    throw error;
  }
}

/**
 * Full sync with database persistence (runs every 10 minutes)
 * Persists to database and updates cache
 */
export async function syncEventLives(eventId: number): Promise<{ count: number; errors: number }> {
  try {
    logInfo('Starting full event live sync with DB persistence', { eventId });

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

    // 3. Save to database: lives + explains are one logical write — if the
    // explains upsert fails after lives committed, the pair goes stale, so
    // both upserts share a single transaction.
    const db = await getDb();
    const savedEventLives = await db.transaction(async (tx) => {
      const txEventLiveRepository = createEventLiveRepository(tx);
      const txExplainsRepository = createEventLiveExplainsRepository(tx);

      const savedLives = await txEventLiveRepository.upsertBatch(eventLives);
      logInfo('Event lives upserted to database', { eventId, count: savedLives.length });

      const savedExplains = await txExplainsRepository.upsertBatch(explains);
      logInfo('Event live explains upserted to database', {
        eventId,
        count: savedExplains.length,
      });

      return savedLives;
    });

    // 4. Update cache with full event live objects
    await eventLivesCache.set(eventId, savedEventLives);
    logInfo('Event lives cache updated', { eventId });

    const result = {
      count: savedEventLives.length,
      errors: liveData.elements.length - eventLives.length,
    };

    logInfo('Full event live sync completed successfully', { eventId, ...result });
    return result;
  } catch (error) {
    logError('Event live sync failed', error, { eventId });
    throw error;
  }
}
