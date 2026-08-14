import { fplClient } from '../clients/fpl';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import { createEntryEventPicksRepository } from '../repositories/entry-event-picks';
import {
  entryEventTransfersRepository,
  withEntrySeasonSyncTransaction,
} from '../repositories/entry-event-transfers';
import { createEntryEventResultsRepository } from '../repositories/entry-event-results';
import type { FplSeasonRef } from '../domain/fpl-season';
import { logError, logInfo } from '../utils/logger';
import type { RawFPLEntryEventPicksResponse } from '../types';

export async function persistEntryEventPicksResponse(
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
  picks: RawFPLEntryEventPicksResponse,
  syncedAt?: Date | string,
) {
  const sourceCheckedAt = syncedAt
    ? new Date(syncedAt)
    : (await readDatabaseOrderingTimestamp()).date;
  await withEntrySeasonSyncTransaction(season, entryId, async (tx) => {
    await createEntryEventPicksRepository(tx).upsertFromPicks(
      season,
      entryId,
      eventId,
      picks,
      sourceCheckedAt,
    );
  });
  return { entryId, eventId };
}

export async function syncEntryEventPicks(season: FplSeasonRef, entryId: number, eventId: number) {
  try {
    logInfo('Starting entry event picks sync', { entryId, eventId });
    const picksSyncStartedAt = await readDatabaseOrderingTimestamp();
    const picks = await fplClient.getEntryEventPicks(entryId, eventId);
    await persistEntryEventPicksResponse(season, entryId, eventId, picks, picksSyncStartedAt.exact);
    logInfo('Entry event picks sync completed', { entryId, eventId });
    return { entryId, eventId };
  } catch (error) {
    logError('Sync entry event picks failed', error, { entryId, eventId });
    throw error;
  }
}

const EVENT_LIVE_POINTS_CACHE_TTL_MS = 5 * 60_000;
const eventLivePointsCache = new Map<string, { expiresAt: number; points: Map<number, number> }>();

async function getPointsByElement(
  seasonCode: string,
  eventId: number,
): Promise<Map<number, number>> {
  const key = `${seasonCode}:${eventId}`;
  const cached = eventLivePointsCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.points;
  }

  const live = await fplClient.getEventLive(eventId);
  const pointsByElement = new Map<number, number>();
  for (const el of live.elements) {
    pointsByElement.set(el.id, el.stats.total_points);
  }

  eventLivePointsCache.set(key, {
    points: pointsByElement,
    expiresAt: now + EVENT_LIVE_POINTS_CACHE_TTL_MS,
  });

  return pointsByElement;
}

interface EntryTransferSyncOptions {
  pointsByElement?: Map<number, number>;
}

export async function syncEntryEventTransfers(
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
  options?: EntryTransferSyncOptions,
) {
  try {
    logInfo('Starting entry event transfers sync', { entryId, eventId });
    const transferSyncStartedAt = await readDatabaseOrderingTimestamp();
    const transfers = await fplClient.getEntryTransfers(entryId);
    const pointsByElement =
      options?.pointsByElement ?? (await getPointsByElement(season.seasonCode, eventId));
    await entryEventTransfersRepository.replaceForEvent(
      season,
      entryId,
      eventId,
      transfers,
      pointsByElement,
      { sourceCheckedAt: transferSyncStartedAt.exact },
    );
    logInfo('Entry event transfers sync completed', { entryId, eventId });
    return { entryId, eventId };
  } catch (error) {
    logError('Sync entry event transfers failed', error, { entryId, eventId });
    throw error;
  }
}

export async function syncEntryEventResults(
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
) {
  try {
    logInfo('Starting entry event results sync', { entryId, eventId });
    // This timestamp describes the evidence window, not database completion.
    // If the GW finalizes while either request is in flight, the persisted
    // marker remains before data_checked_at and the finalized scan refetches it.
    const richSyncStartedAt = await readDatabaseOrderingTimestamp();
    const [picks, live] = await Promise.all([
      fplClient.getEntryEventPicks(entryId, eventId),
      fplClient.getEventLive(eventId),
    ]);
    await withEntrySeasonSyncTransaction(season, entryId, async (tx) => {
      await createEntryEventResultsRepository(tx).upsertFromPicksAndLive(
        season,
        entryId,
        eventId,
        picks,
        live,
        richSyncStartedAt.exact,
      );
    });
    logInfo('Entry event results sync completed', { entryId, eventId });
    return { entryId, eventId };
  } catch (error) {
    logError('Sync entry event results failed', error, { entryId, eventId });
    throw error;
  }
}
