import { readLiveSnapshotCache } from '../cache/live-snapshot-cache';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { EventLive } from '../domain/event-lives';
import type { EventLiveExplain } from '../domain/event-live-explains';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { FplPlayerFixtureEvidence } from '../domain/fpl-player-fixture-stats';
import { createEventLiveExplainsRepository } from '../repositories/event-live-explains';
import { createEventLiveRepository, eventLiveRepository } from '../repositories/event-lives';
import { createFplPlayerFixtureStatsRepository } from '../repositories/fpl-player-fixture-stats';
import { transformEventLiveExplains } from '../transformers/event-live-explains';
import { attachEventLiveFixtureBreakdowns } from '../transformers/event-live-fixture-breakdown';
import { transformEventLives } from '../transformers/event-lives';
import { transformFplPlayerFixtureEvidence } from '../transformers/fpl-player-fixture-stats';
import { logDebug, logError, logInfo } from '../utils/logger';
import { refreshPlayerSeasonSummaries } from './player-season-summaries.service';

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
  const eventLives = attachEventLiveFixtureBreakdowns(
    eventId,
    transformEventLives(eventId, elements),
    elements,
  );
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
 * function so one transaction owns gameweek totals, scoring items, and
 * fixture-grain evidence.
 */
export async function persistPreparedEventLives(
  season: FplSeasonRef,
  prepared: PreparedEventLives,
  dbInstance?: DbOrTransaction,
): Promise<EventLive[]> {
  const { eventId, eventLives, explains, fixtureEvidence } = prepared;
  const persist = async (tx: DbOrTransaction) => {
    const txEventLiveRepository = createEventLiveRepository(tx);
    const txExplainsRepository = createEventLiveExplainsRepository(tx);
    const txFixtureStatsRepository = createFplPlayerFixtureStatsRepository(tx);

    const savedLives = await txEventLiveRepository.upsertBatch(season, eventLives);
    if (savedLives.length !== eventLives.length) {
      throw new Error(
        `Incomplete event live write: expected ${eventLives.length}, persisted ${savedLives.length}`,
      );
    }
    logInfo('Event lives upserted to database', { eventId, count: savedLives.length });

    const savedExplains = await txExplainsRepository.replaceEvent(season, explains);
    logInfo('Event live explains upserted to database', {
      eventId,
      count: savedExplains.length,
    });

    const fixtureChanges = await txFixtureStatsRepository.upsertEvidence(season, fixtureEvidence);
    logInfo('FPL player fixture evidence reconciled', {
      eventId,
      changes: fixtureChanges,
    });

    return eventLives;
  };

  if (dbInstance) {
    return persist(dbInstance);
  }
  const db = await getDb();
  const saved = await db.transaction(persist);
  // Direct callers are also canonical gameweek writers. Keep the reporting
  // read model current after their transaction commits; a failed refresh must
  // not roll back the authoritative event-live facts.
  try {
    await refreshPlayerSeasonSummaries(season);
  } catch (error) {
    logError('Player season summary refresh failed after direct event-live write', error, {
      season: season.seasonCode,
      eventId,
    });
  }
  return saved;
}

/**
 * Get all event live data for a specific event (cache-first strategy: Redis → DB → update Redis)
 */
export async function getEventLivesByEventId(
  season: FplSeasonRef,
  eventId: number,
): Promise<EventLive[]> {
  try {
    const cached = await readLiveSnapshotCache(season.seasonCode, eventId);
    if (cached) {
      logDebug('Event lives retrieved from coherent live publication', {
        eventId,
        count: cached.eventLives.length,
      });
      return [...cached.eventLives];
    }

    logDebug('Event lives cache miss - fetching from database', { eventId });
    const dbEventLives = await eventLiveRepository.findByEventId(season, eventId);

    logDebug('Event lives retrieved from database', { eventId, count: dbEventLives.length });
    return dbEventLives;
  } catch (error) {
    logError('Failed to get event live data', error, { eventId });
    throw error;
  }
}
