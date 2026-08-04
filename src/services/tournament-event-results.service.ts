import { getActiveCacheSeason } from '../cache/cache-season';
import { fplClient } from '../clients/fpl';
import type { TransactionHandle } from '../db/singleton';
import type { TournamentFinalizationTarget } from '../domain/tournament';
import { createEntryEventPicksRepository } from '../repositories/entry-event-picks';
import {
  createEntryEventResultsRepository,
  type EventPointsPayload,
} from '../repositories/entry-event-results';
import {
  entryEventTransfersRepository,
  withEntrySeasonSyncTransaction,
} from '../repositories/entry-event-transfers';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import type { RawFPLEntryTransfersResponse } from '../types';
import { mapWithConcurrency, uniqueNumbers, withTimeout } from '../utils/async';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;
const EVENT_LIVE_FETCH_TIMEOUT_MS = Number(process.env.TOURNAMENT_EVENT_LIVE_TIMEOUT_MS ?? 45_000);
const ENTRY_FETCH_TIMEOUT_MS = Number(process.env.TOURNAMENT_ENTRY_FETCH_TIMEOUT_MS ?? 45_000);
const ENTRY_PERSIST_TIMEOUT_MS = Number(process.env.TOURNAMENT_ENTRY_PERSIST_TIMEOUT_MS ?? 60_000);

type EntrySyncOutcome = {
  entryId: number;
  success: boolean;
};

export type TournamentEventResultsSyncOptions = {
  concurrency?: number;
  live?: EventPointsPayload;
  skipTransfers?: boolean;
  transfersByEntry?: ReadonlyMap<number, RawFPLEntryTransfersResponse>;
};

async function resolveEventPointsPayload(
  eventId: number,
  provided?: EventPointsPayload,
): Promise<EventPointsPayload> {
  if (provided) return provided;

  const live = await withTimeout(
    fplClient.getEventLive(eventId),
    EVENT_LIVE_FETCH_TIMEOUT_MS,
    `Timed out fetching event live data for event ${eventId} after ${EVENT_LIVE_FETCH_TIMEOUT_MS}ms`,
  );
  if (!live.elements || !Array.isArray(live.elements)) {
    throw new Error('Invalid event live data from FPL API');
  }

  return live;
}

async function persistEntryEventData(
  entryId: number,
  eventId: number,
  picks: Awaited<ReturnType<typeof fplClient.getEntryEventPicks>>,
  live: EventPointsPayload,
  checkpointSeason: string,
  transfers: RawFPLEntryTransfersResponse | null,
  pointsByElement: Map<number, number>,
): Promise<void> {
  const persistPicksAndResults = async (tx: TransactionHandle) => {
    const resultsRepository = createEntryEventResultsRepository(tx);
    const picksRepository = createEntryEventPicksRepository(tx);
    await resultsRepository.upsertFromPicksAndLive(entryId, eventId, picks, live);
    await picksRepository.upsertFromPicks(entryId, eventId, picks);
  };

  if (transfers) {
    await entryEventTransfersRepository.replaceForEvent(
      entryId,
      eventId,
      transfers,
      pointsByElement,
      {
        syncMode: 'all',
        checkpointSeason,
        persistEventData: persistPicksAndResults,
      },
    );
    return;
  }

  await withEntrySeasonSyncTransaction(entryId, checkpointSeason, persistPicksAndResults);
}

export async function syncTournamentEventResultsForEntryIds(
  entryIds: number[],
  eventId: number,
  options?: TournamentEventResultsSyncOptions,
): Promise<{ eventId: number; totalEntries: number; synced: number; errors: number }> {
  const uniqueEntryIds = uniqueNumbers(entryIds);
  if (uniqueEntryIds.length === 0) {
    return { eventId, totalEntries: 0, synced: 0, errors: 0 };
  }

  const checkpointSeason = await getActiveCacheSeason();
  const live = await resolveEventPointsPayload(eventId, options?.live);
  const pointsByElement = new Map<number, number>();
  for (const element of live.elements) {
    pointsByElement.set(element.id, element.stats.total_points);
  }

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  let errors = 0;

  const results = await mapWithConcurrency(uniqueEntryIds, concurrency, async (entryId) => {
    try {
      const [picks, transfers] = await withTimeout(
        Promise.all([
          fplClient.getEntryEventPicks(entryId, eventId),
          options?.skipTransfers
            ? Promise.resolve(null)
            : options?.transfersByEntry
              ? Promise.resolve(options.transfersByEntry.get(entryId) ?? [])
              : fplClient.getEntryTransfers(entryId),
        ]),
        ENTRY_FETCH_TIMEOUT_MS,
        `Timed out fetching entry payloads for entry ${entryId}, event ${eventId} after ${ENTRY_FETCH_TIMEOUT_MS}ms`,
      );
      await withTimeout(
        persistEntryEventData(
          entryId,
          eventId,
          picks,
          live,
          checkpointSeason,
          transfers,
          pointsByElement,
        ),
        ENTRY_PERSIST_TIMEOUT_MS,
        `Timed out persisting entry payloads for entry ${entryId}, event ${eventId} after ${ENTRY_PERSIST_TIMEOUT_MS}ms`,
      );
      return { entryId, success: true } satisfies EntrySyncOutcome;
    } catch (error) {
      errors += 1;
      logError('Failed to sync tournament entry results', error, { eventId, entryId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  const synced = results.filter((result) => result.success).length;
  const totalEntries = uniqueEntryIds.length;
  if (errors > 0) {
    throw new Error(
      `Tournament event results sync failed for ${errors} of ${totalEntries} entries`,
    );
  }
  return {
    eventId,
    totalEntries,
    synced,
    errors,
  };
}

export async function syncEntryTransferHistories(
  entryIds: number[],
  endEventId: number,
  options?: { concurrency?: number; season?: string },
): Promise<{ synced: number; errors: number; failedEntryIds: number[] }> {
  const uniqueEntryIds = uniqueNumbers(entryIds);
  const failedEntryIds: number[] = [];
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const checkpointSeason = options?.season ?? (await getActiveCacheSeason());

  const outcomes = await mapWithConcurrency(uniqueEntryIds, concurrency, async (entryId) => {
    try {
      const transfers = await withTimeout(
        fplClient.getEntryTransfers(entryId),
        ENTRY_FETCH_TIMEOUT_MS,
        `Timed out fetching transfer history for entry ${entryId}`,
      );
      await withTimeout(
        entryEventTransfersRepository.replaceForEvent(entryId, endEventId, transfers, undefined, {
          syncMode: 'all',
          checkpointSeason,
        }),
        ENTRY_PERSIST_TIMEOUT_MS,
        `Timed out persisting transfer history for entry ${entryId}`,
      );
      return true;
    } catch (error) {
      failedEntryIds.push(entryId);
      logError('Failed to sync entry transfer history', error, { entryId, endEventId });
      return false;
    }
  });

  return {
    synced: outcomes.filter(Boolean).length,
    errors: failedEntryIds.length,
    failedEntryIds,
  };
}

export async function syncTournamentEventResultsForTournament(
  tournamentId: number,
  eventId: number,
  options?: { concurrency?: number },
): Promise<{ eventId: number; totalEntries: number; synced: number; errors: number }> {
  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(tournamentId);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event results', { tournamentId, eventId });
    return { eventId, totalEntries: 0, synced: 0, errors: 0 };
  }

  const result = await syncTournamentEventResultsForEntryIds(entryIds, eventId, options);
  logInfo('Tournament event results sync completed for tournament', {
    tournamentId,
    eventId,
    totalEntries: result.totalEntries,
    synced: result.synced,
    errors: result.errors,
  });
  return result;
}

export async function syncTournamentEventResults(
  eventId: number,
  options?: { concurrency?: number },
): Promise<{
  eventId: number;
  totalEntries: number;
  synced: number;
  errors: number;
  finalizationTargets: TournamentFinalizationTarget[];
}> {
  logInfo('Starting tournament event results sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for tournament event results', { eventId });
    return { eventId, totalEntries: 0, synced: 0, errors: 0, finalizationTargets: [] };
  }

  const finalizationTargets = tournaments.flatMap((tournament) =>
    tournament.standingsReadyAt
      ? [{ tournamentId: tournament.id, standingsReadyAt: tournament.standingsReadyAt }]
      : [],
  );

  const entryLists = await Promise.all(
    tournaments.map((tournament) =>
      tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id),
    ),
  );

  const entryIds = uniqueNumbers(entryLists.flat());
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event results', { eventId });
    return {
      eventId,
      totalEntries: 0,
      synced: 0,
      errors: 0,
      finalizationTargets,
    };
  }
  const { totalEntries, synced, errors } = await syncTournamentEventResultsForEntryIds(
    entryIds,
    eventId,
    options,
  );

  logInfo('Tournament event results sync completed', {
    eventId,
    totalEntries,
    synced,
    errors,
  });

  return {
    eventId,
    totalEntries,
    synced,
    errors,
    finalizationTargets,
  };
}
