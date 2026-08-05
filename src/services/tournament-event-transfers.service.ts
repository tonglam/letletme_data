import type { DbEntryEventTransfer, DbEventLive } from '../db/schemas/index.schema';
import { isCompleteEntryPicks } from '../domain/entry-picks';
import type { RawFPLEntryEventPickItem } from '../types';
import { getActiveCacheSeason } from '../cache/cache-season';
import { fplClient } from '../clients/fpl';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { entryEventTransfersRepository } from '../repositories/entry-event-transfers';
import { eventLiveRepository } from '../repositories/event-lives';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;

export type EntryTransfersClient = Pick<typeof fplClient, 'getEntryTransfers'>;
export type TournamentTransferSyncOptions = {
  concurrency?: number;
  client?: EntryTransfersClient;
};

type TransferWorkSummary = {
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
};

export function isTournamentTransferCheckpointEvent(eventId: number): boolean {
  return Number.isInteger(eventId) && eventId >= 1 && eventId <= 38;
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
    targetEventId: number,
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

export async function syncTournamentEventTransfersPost(eventId: number): Promise<
  {
    eventId: number;
    totalEntries: number;
    updated: number;
    skipped: number;
    errors: number;
  } & TransferWorkSummary
> {
  if (eventId <= 1 || eventId > 38) {
    logInfo('Skipping tournament event transfers post sync - invalid event', {
      eventId,
    });
    return {
      eventId,
      totalEntries: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  logInfo('Starting tournament event transfers post sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for tournament event transfers', { eventId });
    return {
      eventId,
      totalEntries: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const entryLists = await mapWithConcurrency(tournaments, 10, (tournament) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id),
  );

  const entryIds = uniqueNumbers(entryLists.flat()).filter((entryId) => entryId > 0);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event transfers', { eventId });
    return {
      eventId,
      totalEntries: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const checkpointSeason = await getActiveCacheSeason();
  const staleTransferEntryIds = await entryEventTransfersRepository.findEntryIdsNeedingSync(
    entryIds,
    eventId,
    checkpointSeason,
  );
  if (staleTransferEntryIds.length > 0) {
    throw new IncompleteDataSyncError(
      'Tournament transfer enrichment requires complete transfer checkpoints',
      staleTransferEntryIds.length,
      entryIds.length - staleTransferEntryIds.length,
      0,
      staleTransferEntryIds.length,
    );
  }

  const transfers = await entryEventTransfersRepository.findByEventAndEntryIds(eventId, entryIds);
  if (transfers.length === 0) {
    logInfo('No tournament transfers require post-event enrichment', { eventId });
    return {
      eventId,
      totalEntries: entryIds.length,
      updated: 0,
      skipped: entryIds.length,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: entryIds.length,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const entryResults = await entryEventResultsRepository.findByEventAndEntryIds(eventId, entryIds);
  const requiredElementIds = uniqueNumbers(
    transfers
      .flatMap((transfer) => [transfer.elementInId, transfer.elementOutId])
      .filter((elementId): elementId is number => elementId !== null),
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
  let failedUnits = 0;

  for (const [entryId, entryTransfers] of transferMap) {
    const entryResult = entryResultMap.get(entryId);
    if (!entryResult) {
      logError('Entry event result missing for transfer update', new Error('No result'), {
        eventId,
        entryId,
      });
      failedUnits += entryTransfers.length;
      continue;
    }

    const picks = normalizePicks(entryResult.eventPicks);
    if (!isCompleteEntryPicks(picks)) {
      logError('Entry picks missing for transfer update', new Error('No picks'), {
        eventId,
        entryId,
      });
      failedUnits += entryTransfers.length;
      continue;
    }

    const playedElements = pickElements(picks, entryResult.eventChip ?? null);

    for (const transfer of entryTransfers) {
      const missingElementPoints =
        (transfer.elementInId !== null && !pointsMap.has(transfer.elementInId)) ||
        (transfer.elementOutId !== null && !pointsMap.has(transfer.elementOutId));
      if (missingElementPoints) {
        failedUnits += 1;
        logError('Event points missing for tournament transfer update', new Error('No points'), {
          eventId,
          entryId,
          transferId: transfer.id,
        });
        continue;
      }
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
  failedUnits += Math.max(0, updates.length - updated);
  const succeededUnits = transfers.length - failedUnits;
  const entriesWithTransfers = transferMap.size;
  const skipped = entryIds.length - entriesWithTransfers;
  logInfo('Tournament event transfers post sync completed', {
    eventId,
    totalEntries: entryIds.length,
    updated,
    skipped,
    failedUnits,
  });

  if (failedUnits > 0) {
    throw new IncompleteDataSyncError(
      'Tournament transfer enrichment did not converge for every transfer',
      transfers.length,
      0,
      succeededUnits,
      failedUnits,
    );
  }

  return {
    eventId,
    totalEntries: entryIds.length,
    updated,
    skipped,
    errors: 0,
    requiredUnits: transfers.length,
    reusedUnits: 0,
    succeededUnits,
    failedUnits: 0,
  };
}

export async function syncTournamentEventTransfersPre(
  eventId: number,
  options?: TournamentTransferSyncOptions,
): Promise<
  {
    eventId: number;
    totalEntries: number;
    inserted: number;
    skipped: number;
    errors: number;
  } & TransferWorkSummary
> {
  if (!isTournamentTransferCheckpointEvent(eventId)) {
    logInfo('Skipping tournament event transfers pre sync - invalid event', {
      eventId,
    });
    return {
      eventId,
      totalEntries: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  logInfo('Starting tournament event transfers pre sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for tournament event transfers', { eventId });
    return {
      eventId,
      totalEntries: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const entryLists = await mapWithConcurrency(tournaments, 10, (tournament) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id),
  );

  const entryIds = uniqueNumbers(entryLists.flat()).filter((entryId) => entryId > 0);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event transfers', { eventId });
    return {
      eventId,
      totalEntries: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const checkpointSeason = await getActiveCacheSeason();
  const pendingEntryIds = await entryEventTransfersRepository.findEntryIdsNeedingSync(
    entryIds,
    eventId,
    checkpointSeason,
  );
  let skipped = entryIds.length - pendingEntryIds.length;

  if (pendingEntryIds.length === 0) {
    logInfo('No tournament entries pending transfer insert', { eventId });
    return {
      eventId,
      totalEntries: entryIds.length,
      inserted: 0,
      skipped,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: skipped,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const client = options?.client ?? fplClient;
  let inserted = 0;

  await mapWithConcurrency(pendingEntryIds, concurrency, async (entryId) => {
    try {
      const transfers = await client.getEntryTransfers(entryId);
      const hasEventTransfers = transfers.some((transfer) => transfer.event === eventId);
      await entryEventTransfersRepository.replaceForEvent(entryId, eventId, transfers, undefined, {
        elementInPlayed: false,
        defaultPoints: 0,
        checkpointSeason,
        syncMode: 'all',
      });
      if (hasEventTransfers) {
        inserted += 1;
      } else {
        skipped += 1;
      }
      return null;
    } catch (error) {
      logError('Failed to sync tournament entry transfers', error, {
        eventId,
        entryId,
      });
      return null;
    }
  });

  const stillMissing = await entryEventTransfersRepository.findEntryIdsNeedingSync(
    pendingEntryIds,
    eventId,
    checkpointSeason,
  );
  const failedUnits = stillMissing.length;
  const succeededUnits = pendingEntryIds.length - failedUnits;
  const errors = failedUnits;

  logInfo('Tournament event transfers pre sync completed', {
    eventId,
    totalEntries: entryIds.length,
    inserted,
    skipped,
    errors,
  });

  if (failedUnits > 0) {
    throw new IncompleteDataSyncError(
      'Tournament transfer history did not converge for every active entry',
      pendingEntryIds.length,
      entryIds.length - pendingEntryIds.length,
      succeededUnits,
      failedUnits,
    );
  }

  return {
    eventId,
    totalEntries: entryIds.length,
    inserted,
    skipped,
    errors,
    requiredUnits: pendingEntryIds.length,
    reusedUnits: entryIds.length - pendingEntryIds.length,
    succeededUnits,
    failedUnits,
  };
}
