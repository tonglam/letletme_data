import { sql } from 'drizzle-orm';

import { readLivePublicationV2 } from '../cache/live-publication-v2';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { EventLive } from '../domain/event-lives';
import type { EventLiveExplain } from '../domain/event-live-explains';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { FplPlayerFixtureEvidence } from '../domain/fpl-player-fixture-stats';
import { createEventLiveExplainsRepository } from '../repositories/event-live-explains';
import { createEventLiveRepository } from '../repositories/event-lives';
import { createFplPlayerFixtureStatsRepository } from '../repositories/fpl-player-fixture-stats';
import { transformEventLiveExplains } from '../transformers/event-live-explains';
import { attachEventLiveFixtureBreakdowns } from '../transformers/event-live-fixture-breakdown';
import { transformEventLives } from '../transformers/event-lives';
import { transformFplPlayerFixtureEvidence } from '../transformers/fpl-player-fixture-stats';
import { logDebug, logError, logInfo } from '../utils/logger';
import { refreshPlayerSeasonSummaries } from './player-season-summaries.service';
import { readLivePublicationV2Checkpoint } from './live-publication-v2-checkpoint.service';

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
    // Direct callers do not necessarily arrive through the V2 checkpoint
    // scope fence. Serialize the read/diff/write scoring reconciliation with
    // every other writer for this season/event.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${season.seasonCode}:${eventId}`}, 0))`,
    );
    const txEventLiveRepository = createEventLiveRepository(tx);
    const txExplainsRepository = createEventLiveExplainsRepository(tx);
    const txFixtureStatsRepository = createFplPlayerFixtureStatsRepository(tx);

    // ON CONFLICT ... WHERE intentionally omits unchanged conflict rows from
    // RETURNING. The statement is still atomic and the input is the complete
    // source snapshot, so a shorter result means a no-op replay, not a partial
    // write. Checkpoint callers validate the source count/hash separately.
    const changedLives = await txEventLiveRepository.upsertBatch(season, eventLives);
    logInfo('Event lives upserted to database', {
      eventId,
      sourceCount: eventLives.length,
      changedCount: changedLives.length,
    });

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

    return {
      eventLives,
      changed: changedLives.length > 0 || savedExplains.length > 0 || fixtureChanges > 0,
    };
  };

  if (dbInstance) {
    const result = await persist(dbInstance);
    return result.eventLives;
  }
  const db = await getDb();
  const saved = await db.transaction(persist);
  // Direct callers are also canonical gameweek writers. Keep the reporting
  // read model current after their transaction commits; a failed refresh must
  // not roll back the authoritative event-live facts.
  if (saved.changed) {
    try {
      await refreshPlayerSeasonSummaries(season);
    } catch (error) {
      logError('Player season summary refresh failed after direct event-live write', error, {
        season: season.seasonCode,
        eventId,
      });
    }
  } else {
    logDebug('Skipped player season summary refresh for unchanged event-live snapshot', {
      season: season.seasonCode,
      eventId,
    });
  }
  return saved.eventLives;
}

/**
 * Get all event live data for a specific event (cache-first strategy: Redis → DB → update Redis)
 */
export async function getEventLivesByEventId(
  season: FplSeasonRef,
  eventId: number,
): Promise<EventLive[]> {
  let redisError: unknown = null;
  try {
    const cached = await readLivePublicationV2({ season: season.seasonCode, eventId });
    if (cached) {
      logDebug('Event lives retrieved from Live Points V2 publication', {
        eventId,
        count: cached.eventLives.length,
      });
      return [...cached.eventLives];
    }
  } catch (error) {
    redisError = error;
    logDebug('Live Points V2 Redis read unavailable; trying complete checkpoint', { eventId });
  }
  const checkpoint = await readLivePublicationV2Checkpoint(season, eventId);
  if (checkpoint) {
    logDebug('Event lives retrieved from V2 PostgreSQL checkpoint', {
      eventId,
      count: checkpoint.eventLives.length,
      redisError: redisError ? 'UNAVAILABLE' : undefined,
    });
    return [...checkpoint.eventLives];
  }
  throw redisError instanceof Error
    ? redisError
    : new Error(`No complete Live Points V2 publication for event ${eventId}`);
}
