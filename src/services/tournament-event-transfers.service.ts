import type { DbEntryEventTransfer, DbEventLive } from '../db/schemas/index.schema';
import type { RawFPLEntryEventPickItem } from '../types';
import { getActiveCacheSeason } from '../cache/cache-season';
import { fplClient } from '../clients/fpl';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { entryEventTransfersRepository } from '../repositories/entry-event-transfers';
import { eventLiveRepository } from '../repositories/event-lives';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;

export type EntryTransfersClient = Pick<typeof fplClient, 'getEntryTransfers'>;
export type TournamentTransferSyncOptions = {
  concurrency?: number;
  client?: EntryTransfersClient;
};

function normalizePicks(raw: unknown): RawFPLEntryEventPickItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw as RawFPLEntryEventPickItem[];
}

function pickElements(picks: RawFPLEntryEventPickItem[], chip: string | null): Set<number> {
  if (chip === 'bboost') {
    return new Set(picks.map((pick) => pick.element));
  }
  return new Set(picks.filter((pick) => pick.position <= 11).map((pick) => pick.element));
}

export function buildTournamentTransferPointsMap(
  eventId: number,
  eventLives: ReadonlyArray<Pick<DbEventLive, 'elementId' | 'totalPoints'>>,
  requiredElementIds: readonly number[] = [],
): Map<number, number> {
  if (eventLives.length === 0) {
    throw new Error(
      `Event live data is not consolidated for tournament transfer enrichment in event ${eventId}`,
    );
  }
  const points = new Map(eventLives.map((live) => [live.elementId, live.totalPoints]));
  const missingElementIds = uniqueNumbers(requiredElementIds).filter(
    (elementId) => !points.has(elementId),
  );
  if (missingElementIds.length > 0) {
    throw new Error(
      `Event live data is incomplete for tournament transfer enrichment in event ${eventId}; ` +
        `missing elements: ${missingElementIds.slice(0, 10).join(',')}`,
    );
  }
  return points;
}

export async function loadCanonicalTournamentTransferPointsMap(
  eventId: number,
  checkpointSeason: string,
  requiredElementIds: readonly number[] = [],
  findCanonicalRows: (
    eventId: number,
    season: string,
  ) => Promise<ReadonlyArray<Pick<DbEventLive, 'elementId' | 'totalPoints'>>> = (
    targetEventId,
    season,
  ) => eventLiveRepository.findFinalizedByEventIdForSeason(targetEventId, season),
): Promise<Map<number, number>> {
  return buildTournamentTransferPointsMap(
    eventId,
    await findCanonicalRows(eventId, checkpointSeason),
    requiredElementIds,
  );
}

export async function syncTournamentEventTransfersPost(eventId: number): Promise<{
  eventId: number;
  totalEntries: number;
  updated: number;
  skipped: number;
  errors: number;
}> {
  if (eventId <= 1 || eventId > 38) {
    logInfo('Skipping tournament event transfers post sync - invalid event', {
      eventId,
    });
    return { eventId, totalEntries: 0, updated: 0, skipped: 0, errors: 0 };
  }

  logInfo('Starting tournament event transfers post sync', { eventId });
  const checkpointSeason = await getActiveCacheSeason();

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for tournament event transfers', { eventId });
    return { eventId, totalEntries: 0, updated: 0, skipped: 0, errors: 0 };
  }

  const entryLists = await Promise.all(
    tournaments.map((tournament) =>
      tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id),
    ),
  );

  const entryIds = uniqueNumbers(entryLists.flat()).filter((entryId) => entryId > 0);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event transfers', { eventId });
    return { eventId, totalEntries: 0, updated: 0, skipped: 0, errors: 0 };
  }

  const [entryResults, transfers] = await Promise.all([
    entryEventResultsRepository.findByEventAndEntryIds(eventId, entryIds),
    entryEventTransfersRepository.findByEventAndEntryIds(eventId, entryIds),
  ]);

  if (entryResults.length === 0) {
    logError('Entry event results missing for tournament transfers', new Error('No results'), {
      eventId,
    });
    return {
      eventId,
      totalEntries: entryIds.length,
      updated: 0,
      skipped: entryIds.length,
      errors: 0,
    };
  }

  if (transfers.length === 0) {
    logError('Entry event transfers missing for tournament transfers', new Error('No transfers'), {
      eventId,
    });
    return {
      eventId,
      totalEntries: entryIds.length,
      updated: 0,
      skipped: entryIds.length,
      errors: 0,
    };
  }

  const requiredElementIds = uniqueNumbers(
    transfers
      .flatMap((transfer) => [transfer.elementInId, transfer.elementOutId])
      .filter((elementId): elementId is number => elementId !== null && elementId > 0),
  );
  const pointsMap = await loadCanonicalTournamentTransferPointsMap(
    eventId,
    checkpointSeason,
    requiredElementIds,
  );

  const entryResultMap = new Map(entryResults.map((result) => [result.entryId, result]));
  const transferMap = new Map<number, DbEntryEventTransfer[]>();
  for (const transfer of transfers) {
    const list = transferMap.get(transfer.entryId) ?? [];
    list.push(transfer);
    transferMap.set(transfer.entryId, list);
  }

  const updates: Array<{
    id: number;
    entryId: number;
    elementInPoints: number | null;
    elementOutPoints: number | null;
    elementInPlayed: boolean | null;
  }> = [];
  let skipped = 0;

  for (const entryId of entryIds) {
    const entryResult = entryResultMap.get(entryId);
    if (!entryResult) {
      logError('Entry event result missing for transfer update', new Error('No result'), {
        eventId,
        entryId,
      });
      skipped += 1;
      continue;
    }

    const picks = normalizePicks(entryResult.eventPicks);
    if (picks.length === 0) {
      logError('Entry picks missing for transfer update', new Error('No picks'), {
        eventId,
        entryId,
      });
      skipped += 1;
      continue;
    }

    const entryTransfers = transferMap.get(entryId);
    if (!entryTransfers || entryTransfers.length === 0) {
      logError('Entry event transfers missing for update', new Error('No transfers'), {
        eventId,
        entryId,
      });
      skipped += 1;
      continue;
    }

    const playedElements = pickElements(picks, entryResult.eventChip ?? null);

    for (const transfer of entryTransfers) {
      const elementInPoints = transfer.elementInId
        ? (pointsMap.get(transfer.elementInId) ?? null)
        : null;
      const elementOutPoints = transfer.elementOutId
        ? (pointsMap.get(transfer.elementOutId) ?? null)
        : null;
      const elementInPlayed = transfer.elementInId
        ? playedElements.has(transfer.elementInId)
        : null;

      updates.push({
        id: transfer.id,
        entryId,
        elementInPoints,
        elementOutPoints,
        elementInPlayed,
      });
    }
  }

  const updated = await entryEventTransfersRepository.updateBatchById(updates, checkpointSeason);
  logInfo('Tournament event transfers post sync completed', {
    eventId,
    totalEntries: entryIds.length,
    updated,
    skipped,
  });

  return { eventId, totalEntries: entryIds.length, updated, skipped, errors: 0 };
}

export async function syncTournamentEventTransfersPre(
  eventId: number,
  options?: TournamentTransferSyncOptions,
): Promise<{
  eventId: number;
  totalEntries: number;
  inserted: number;
  skipped: number;
  errors: number;
}> {
  if (eventId <= 1 || eventId > 38) {
    logInfo('Skipping tournament event transfers pre sync - invalid event', {
      eventId,
    });
    return { eventId, totalEntries: 0, inserted: 0, skipped: 0, errors: 0 };
  }

  logInfo('Starting tournament event transfers pre sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for tournament event transfers', { eventId });
    return { eventId, totalEntries: 0, inserted: 0, skipped: 0, errors: 0 };
  }

  const entryLists = await Promise.all(
    tournaments.map((tournament) =>
      tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id),
    ),
  );

  const entryIds = uniqueNumbers(entryLists.flat()).filter((entryId) => entryId > 0);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event transfers', { eventId });
    return { eventId, totalEntries: 0, inserted: 0, skipped: 0, errors: 0 };
  }

  const existingTransfers = await entryEventTransfersRepository.findByEventAndEntryIds(
    eventId,
    entryIds,
  );
  const existingEntryIds = new Set(existingTransfers.map((transfer) => transfer.entryId));
  const pendingEntryIds = entryIds.filter((entryId) => !existingEntryIds.has(entryId));
  let skipped = entryIds.length - pendingEntryIds.length;

  if (pendingEntryIds.length === 0) {
    logInfo('No tournament entries pending transfer insert', { eventId });
    return {
      eventId,
      totalEntries: entryIds.length,
      inserted: 0,
      skipped,
      errors: 0,
    };
  }

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const client = options?.client ?? fplClient;
  const checkpointSeason = await getActiveCacheSeason();
  let inserted = 0;
  let errors = 0;

  await mapWithConcurrency(pendingEntryIds, concurrency, async (entryId) => {
    try {
      const transfers = await client.getEntryTransfers(entryId);
      const hasEventTransfers = transfers.some((transfer) => transfer.event === eventId);
      if (!hasEventTransfers) {
        skipped += 1;
        return null;
      }

      await entryEventTransfersRepository.replaceForEvent(entryId, eventId, transfers, undefined, {
        elementInPlayed: false,
        defaultPoints: 0,
        checkpointSeason,
      });
      inserted += 1;
      return null;
    } catch (error) {
      errors += 1;
      logError('Failed to sync tournament entry transfers', error, {
        eventId,
        entryId,
      });
      return null;
    }
  });

  logInfo('Tournament event transfers pre sync completed', {
    eventId,
    totalEntries: entryIds.length,
    inserted,
    skipped,
    errors,
  });

  if (errors > 0) {
    throw new Error(
      `Tournament event transfers pre sync failed for ${errors} entries (eventId=${eventId})`,
    );
  }

  return { eventId, totalEntries: entryIds.length, inserted, skipped, errors };
}
