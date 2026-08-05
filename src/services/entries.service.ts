import { getActiveCacheSeason } from '../cache/cache-season';
import { fplClient } from '../clients/fpl';
import { createEntryEventPicksRepository } from '../repositories/entry-event-picks';
import {
  entryEventTransfersRepository,
  withEntrySeasonSyncTransaction,
} from '../repositories/entry-event-transfers';
import { createEntryEventResultsRepository } from '../repositories/entry-event-results';
import { logError, logInfo } from '../utils/logger';
import { getCurrentEvent } from './events.service';

export async function syncEntryEventPicks(entryId: number, eventId?: number) {
  try {
    logInfo('Starting entry event picks sync', { entryId, eventId });
    // Determine event id if not provided (use current event)
    let targetEventId = eventId;
    if (!targetEventId) {
      const current = await getCurrentEvent();
      if (!current) throw new Error('No current event found');
      targetEventId = current.id;
    }
    const checkpointSeason = await getActiveCacheSeason();
    const picks = await fplClient.getEntryEventPicks(entryId, targetEventId);
    await withEntrySeasonSyncTransaction(entryId, checkpointSeason, async (tx) => {
      await createEntryEventPicksRepository(tx).upsertFromPicks(entryId, targetEventId, picks);
    });
    logInfo('Entry event picks sync completed', { entryId, eventId: targetEventId });
    return { entryId, eventId: targetEventId };
  } catch (error) {
    logError('Sync entry event picks failed', error, { entryId, eventId });
    throw error;
  }
}

const EVENT_LIVE_POINTS_CACHE_TTL_MS = 5 * 60_000;
const eventLivePointsCache = new Map<number, { expiresAt: number; points: Map<number, number> }>();

async function getPointsByElement(eventId: number): Promise<Map<number, number>> {
  const cached = eventLivePointsCache.get(eventId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.points;
  }

  const live = await fplClient.getEventLive(eventId);
  const pointsByElement = new Map<number, number>();
  for (const el of live.elements) {
    pointsByElement.set(el.id, el.stats.total_points);
  }

  eventLivePointsCache.set(eventId, {
    points: pointsByElement,
    expiresAt: now + EVENT_LIVE_POINTS_CACHE_TTL_MS,
  });

  return pointsByElement;
}

interface EntryTransferSyncOptions {
  pointsByElement?: Map<number, number>;
}

export async function syncEntryEventTransfers(
  entryId: number,
  eventId?: number,
  options?: EntryTransferSyncOptions,
) {
  try {
    logInfo('Starting entry event transfers sync', { entryId, eventId });
    // Determine event id if not provided (use current event)
    let targetEventId = eventId;
    if (!targetEventId) {
      const current = await getCurrentEvent();
      if (!current) throw new Error('No current event found');
      targetEventId = current.id;
    }
    const checkpointSeason = await getActiveCacheSeason();
    const transfers = await fplClient.getEntryTransfers(entryId);
    const pointsByElement = options?.pointsByElement ?? (await getPointsByElement(targetEventId));
    await entryEventTransfersRepository.replaceForEvent(
      entryId,
      targetEventId,
      transfers,
      pointsByElement,
      { checkpointSeason },
    );
    logInfo('Entry event transfers sync completed', { entryId, eventId: targetEventId });
    return { entryId, eventId: targetEventId };
  } catch (error) {
    logError('Sync entry event transfers failed', error, { entryId, eventId });
    throw error;
  }
}

export async function syncEntryEventResults(entryId: number, eventId?: number) {
  try {
    logInfo('Starting entry event results sync', { entryId, eventId });
    // Determine event id if not provided (use current event)
    let targetEventId = eventId;
    if (!targetEventId) {
      const current = await getCurrentEvent();
      if (!current) throw new Error('No current event found');
      targetEventId = current.id;
    }
    const checkpointSeason = await getActiveCacheSeason();
    const [picks, live] = await Promise.all([
      fplClient.getEntryEventPicks(entryId, targetEventId),
      fplClient.getEventLive(targetEventId),
    ]);
    await withEntrySeasonSyncTransaction(entryId, checkpointSeason, async (tx) => {
      await createEntryEventResultsRepository(tx).upsertFromPicksAndLive(
        entryId,
        targetEventId,
        picks,
        live,
      );
    });
    logInfo('Entry event results sync completed', { entryId, eventId: targetEventId });
    return { entryId, eventId: targetEventId };
  } catch (error) {
    logError('Sync entry event results failed', error, { entryId, eventId });
    throw error;
  }
}
