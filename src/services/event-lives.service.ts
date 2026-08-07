import { eventLivesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { EventLive } from '../domain/event-lives';
import type { EventLiveExplain } from '../domain/event-live-explains';
import { createEventLiveExplainsRepository } from '../repositories/event-live-explains';
import { createEventLiveRepository, eventLiveRepository } from '../repositories/event-lives';
import { createFplPlayerFixtureStatsRepository } from '../repositories/fpl-player-fixture-stats';
import type { FplPlayerFixtureEvidence } from '../domain/fpl-player-fixture-stats';
import { getActiveCacheSeasonUncached } from '../cache/cache-season';
import { transformFplPlayerFixtureEvidence } from '../transformers/fpl-player-fixture-stats';
import { transformEventLiveExplains } from '../transformers/event-live-explains';
import { transformEventLives } from '../transformers/event-lives';
import { logDebug, logError, logInfo, logWarn } from '../utils/logger';

import type { RawFPLEventLiveElement } from '../types';

/**
 * Event Lives Service - Business Logic Layer
 *
 * Handles all event live data operations:
 * - Data synchronization from FPL API
 * - Cache management
 * - Database operations
 * - Data retrieval with fallbacks
 */

export interface PreparedEventLives {
  eventId: number;
  sourceCount: number;
  eventLives: EventLive[];
  explains: EventLiveExplain[];
  fixtureEvidence: FplPlayerFixtureEvidence[];
  errors: number;
}

export function prepareEventLives(
  eventId: number,
  elements: RawFPLEventLiveElement[],
): PreparedEventLives {
  const eventLives = transformEventLives(eventId, elements);
  const explains = transformEventLiveExplains(eventId, elements);
  const fixtureEvidence = transformFplPlayerFixtureEvidence(eventId, elements);
  return {
    eventId,
    sourceCount: elements.length,
    eventLives,
    explains,
    fixtureEvidence,
    errors: elements.length - eventLives.length,
  };
}

/**
 * Persist one already-fetched FPL snapshot. Network I/O must happen before this
 * function so the transaction only contains the two related UPSERTs.
 */
export async function persistPreparedEventLives(
  prepared: PreparedEventLives,
  dbInstance?: DbOrTransaction,
  season?: string,
): Promise<EventLive[]> {
  const { eventId, eventLives, explains } = prepared;
  // Keep injected/legacy prepared snapshots compatible while the new
  // per-fixture evidence field rolls out across workers and tests.
  const fixtureEvidence = prepared.fixtureEvidence ?? [];
  let evidenceSeason = season ?? null;
  if (fixtureEvidence.length > 0 && !evidenceSeason) {
    try {
      evidenceSeason = await getActiveCacheSeasonUncached();
    } catch (error) {
      logWarn('Skipping FPL fixture evidence because active season is unavailable', {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const persist = async (tx: DbOrTransaction) => {
    const txEventLiveRepository = createEventLiveRepository(tx);
    const txExplainsRepository = createEventLiveExplainsRepository(tx);
    const txFixtureStatsRepository = createFplPlayerFixtureStatsRepository(tx);

    const savedLives = await txEventLiveRepository.upsertBatch(eventLives);
    logInfo('Event lives upserted to database', { eventId, count: savedLives.length });

    const savedExplains = await txExplainsRepository.upsertBatch(explains);
    logInfo('Event live explains upserted to database', {
      eventId,
      count: savedExplains.length,
    });

    if (evidenceSeason) {
      await txFixtureStatsRepository.upsertEvidence(evidenceSeason, fixtureEvidence);
    }

    return savedLives;
  };

  if (dbInstance) {
    return persist(dbInstance);
  }
  const db = await getDb();
  return db.transaction(persist);
}

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

    const { eventLives } = prepareEventLives(eventId, liveData.elements);
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
    const prepared = prepareEventLives(eventId, liveData.elements);
    const { eventLives } = prepared;
    logInfo('Event lives transformed', {
      eventId,
      total: liveData.elements.length,
      successful: eventLives.length,
      errors: liveData.elements.length - eventLives.length,
    });

    // 3. Save to database: lives + explains are one logical write — if the
    // explains upsert fails after lives committed, the pair goes stale, so
    // both upserts share a single transaction.
    const savedEventLives = await persistPreparedEventLives(prepared);

    // 4. Update cache with full event live objects
    await eventLivesCache.set(eventId, savedEventLives);
    logInfo('Event lives cache updated', { eventId });

    const result = {
      count: savedEventLives.length,
      errors: prepared.errors,
    };

    logInfo('Full event live sync completed successfully', { eventId, ...result });
    return result;
  } catch (error) {
    logError('Event live sync failed', error, { eventId });
    throw error;
  }
}
