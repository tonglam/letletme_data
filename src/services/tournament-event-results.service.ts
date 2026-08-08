import { getActiveCacheSeason } from '../cache/cache-season';
import { eventLivesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import {
  createEntryEventPicksRepository,
  entryEventPicksRepository,
} from '../repositories/entry-event-picks';
import {
  createEntryEventResultsRepository,
  entryEventResultsRepository,
  type EventPointsPayload,
} from '../repositories/entry-event-results';
import {
  entryEventTransfersRepository,
  withEntrySeasonSyncTransaction,
} from '../repositories/entry-event-transfers';
import { eventLiveRepository } from '../repositories/event-lives';
import { eventRepository } from '../repositories/events';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import type { RawFPLEntryTransfersResponse } from '../types';
import { mapWithConcurrency, uniqueNumbers, withTimeout } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import type { TournamentFinalizationTarget } from '../domain/tournament';

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
  transferSourceCheckedAt?: string;
  sourceCheckedAt?: string;
  season?: string;
  freshAfter?: Date | string;
};

type TournamentResultWorkSummary = {
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
};

function orderingTimestampDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('A valid result freshness timestamp is required');
  }
  return date;
}

export function findFreshTournamentResultEntryIds(
  rows: ReadonlyArray<{ entryId: number; richSyncedAt: Date | null }>,
  freshAfter: Date,
): Set<number> {
  const cutoff = freshAfter.getTime();
  return new Set(
    rows
      .filter((row) => row.richSyncedAt !== null && row.richSyncedAt.getTime() >= cutoff)
      .map((row) => row.entryId),
  );
}

export function planTournamentEventSync(
  entryIds: readonly number[],
  freshResultEntryIds: ReadonlySet<number>,
  persistedPickEntryIds: ReadonlySet<number>,
  staleTransferEntryIds: ReadonlySet<number>,
  skipTransfers = false,
): {
  requiredResultEntryIds: number[];
  requiredTransferEntryIds: number[];
  reusedUnits: number;
} {
  const requiredResultEntryIds = entryIds.filter(
    (entryId) => !freshResultEntryIds.has(entryId) || !persistedPickEntryIds.has(entryId),
  );
  const requiredTransferEntryIds = skipTransfers
    ? []
    : entryIds.filter((entryId) => staleTransferEntryIds.has(entryId));
  const reusedUnits =
    entryIds.length -
    requiredResultEntryIds.length +
    (skipTransfers ? 0 : entryIds.length - requiredTransferEntryIds.length);

  return { requiredResultEntryIds, requiredTransferEntryIds, reusedUnits };
}

async function resolveEventPointsPayload(
  eventId: number,
  provided?: EventPointsPayload,
  options?: { season?: string },
): Promise<EventPointsPayload> {
  if (provided) return provided;

  const season = options?.season ?? (await getActiveCacheSeason());
  const event = await eventRepository.findById(eventId);
  const finalizationBoundary = event?.finished && event.dataChecked && event.dataCheckedAt !== null;

  if (finalizationBoundary) {
    // Once data_checked_at exists, the compatibility cache may still contain
    // an in-match payload. Only a season-owned final snapshot can satisfy a
    // finalized calculation; otherwise continue to the authoritative source.
    const finalized = await eventLiveRepository.findFinalizedByEventIdForSeason(eventId, season);
    if (finalized.length > 0) {
      return {
        elements: finalized.map((row) => ({
          id: row.elementId,
          stats: { total_points: row.totalPoints },
        })),
      };
    }
  } else {
    // A compatibility cache hit is bounded by its normal Redis TTL and can be
    // reused for active-GW calculations. Database rows without finalized
    // source evidence may still be provisional, so they do not suppress the
    // upstream read below.
    const cached = await eventLivesCache.getByEventId(eventId);
    if (cached && cached.length > 0) {
      return {
        elements: cached.map((row) => ({
          id: row.elementId,
          stats: { total_points: row.totalPoints },
        })),
      };
    }

    const finalized = await eventLiveRepository.findFinalizedByEventIdForSeason(eventId, season);
    if (finalized.length > 0) {
      return {
        elements: finalized.map((row) => ({
          id: row.elementId,
          stats: { total_points: row.totalPoints },
        })),
      };
    }
  }

  const live = await withTimeout(
    fplClient.getEventLive(eventId),
    EVENT_LIVE_FETCH_TIMEOUT_MS,
    `Timed out fetching event live data for event ${eventId} after ${EVENT_LIVE_FETCH_TIMEOUT_MS}ms`,
  );
  if (!live.elements || !Array.isArray(live.elements)) {
    throw new Error('Invalid event live data from FPL API');
  }

  // This is a calculation fallback, not a live-snapshot publisher. Persisting
  // it here could let a request that started before finalization overwrite the
  // canonical final rows after the snapshot commits. The regular live pipeline
  // owns durable/cache publication and its ordering fences.
  return live;
}

export async function syncTournamentEventResultsForEntryIds(
  entryIds: number[],
  eventId: number,
  options?: TournamentEventResultsSyncOptions,
): Promise<
  {
    eventId: number;
    totalEntries: number;
    synced: number;
    errors: number;
  } & TournamentResultWorkSummary
> {
  const uniqueEntryIds = uniqueNumbers(entryIds);
  if (uniqueEntryIds.length === 0) {
    return {
      eventId,
      totalEntries: 0,
      synced: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const sourceOrdering = options?.sourceCheckedAt
    ? {
        date: orderingTimestampDate(options.sourceCheckedAt),
        exact: options.sourceCheckedAt,
      }
    : await readDatabaseOrderingTimestamp();
  const freshAfter = options?.freshAfter
    ? orderingTimestampDate(options.freshAfter)
    : sourceOrdering.date;
  const checkpointSeason = options?.season ?? (await getActiveCacheSeason());
  const transferSourceCheckedAt = options?.skipTransfers
    ? null
    : (options?.transferSourceCheckedAt ?? sourceOrdering.exact);
  const live = await resolveEventPointsPayload(eventId, options?.live, {
    season: checkpointSeason,
  });
  const pointsByElement = new Map<number, number>();
  for (const element of live.elements) {
    pointsByElement.set(element.id, element.stats.total_points);
  }

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  await mapWithConcurrency(uniqueEntryIds, concurrency, async (entryId) => {
    try {
      const [picks, transfers] = await withTimeout(
        Promise.all([
          fplClient.getEntryEventPicks(entryId, eventId),
          options?.skipTransfers
            ? Promise.resolve(null)
            : options?.transfersByEntry
              ? options.transfersByEntry.has(entryId)
                ? Promise.resolve(options.transfersByEntry.get(entryId)!)
                : Promise.reject(new Error('Transfer payload is missing for requested entry'))
              : fplClient.getEntryTransfers(entryId),
        ]),
        ENTRY_FETCH_TIMEOUT_MS,
        `Timed out fetching entry payloads for entry ${entryId}, event ${eventId} after ${ENTRY_FETCH_TIMEOUT_MS}ms`,
      );
      await withTimeout(
        withEntrySeasonSyncTransaction(entryId, checkpointSeason, async (tx) => {
          await createEntryEventResultsRepository(tx).upsertFromPicksAndLive(
            entryId,
            eventId,
            picks,
            live,
            sourceOrdering.exact,
          );
          await createEntryEventPicksRepository(tx).upsertFromPicks(
            entryId,
            eventId,
            picks,
            sourceOrdering.exact,
          );
        }),
        ENTRY_PERSIST_TIMEOUT_MS,
        `Timed out persisting entry payloads for entry ${entryId}, event ${eventId} after ${ENTRY_PERSIST_TIMEOUT_MS}ms`,
      );
      if (transfers) {
        await entryEventTransfersRepository.replaceForEvent(
          entryId,
          eventId,
          transfers,
          pointsByElement,
          // The endpoint returned the entrant's complete transfer history.
          // Persist and checkpoint that same scope so the following audit
          // cannot reject a successful legacy/backfill repair.
          { syncMode: 'all', checkpointSeason, sourceCheckedAt: transferSourceCheckedAt! },
        );
      }
      return { entryId, success: true } satisfies EntrySyncOutcome;
    } catch (error) {
      logError('Failed to sync tournament entry results', error, { eventId, entryId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  const [persistedResults, persistedPickEntryIds, missingTransferEntryIds] = await Promise.all([
    entryEventResultsRepository.findByEventAndEntryIds(eventId, uniqueEntryIds),
    entryEventPicksRepository.findEntryIdsByEvent(eventId, uniqueEntryIds, checkpointSeason),
    options?.skipTransfers
      ? Promise.resolve([])
      : entryEventTransfersRepository.findEntryIdsNeedingSync(
          uniqueEntryIds,
          eventId,
          checkpointSeason,
        ),
  ]);
  const freshResultEntryIds = findFreshTournamentResultEntryIds(persistedResults, freshAfter);
  const persistedPickSet = new Set(persistedPickEntryIds);
  const missingTransferSet = new Set(missingTransferEntryIds);
  const failedEntryIds = uniqueEntryIds.filter(
    (entryId) =>
      !freshResultEntryIds.has(entryId) ||
      !persistedPickSet.has(entryId) ||
      missingTransferSet.has(entryId),
  );
  const totalEntries = uniqueEntryIds.length;
  const failedUnits = failedEntryIds.length;
  const synced = totalEntries - failedUnits;
  const errors = failedUnits;
  if (failedUnits > 0) {
    throw new IncompleteDataSyncError(
      'Tournament event results did not converge for every requested entry',
      totalEntries,
      0,
      synced,
      failedUnits,
    );
  }
  return {
    eventId,
    totalEntries,
    synced,
    errors,
    requiredUnits: totalEntries,
    reusedUnits: 0,
    succeededUnits: synced,
    failedUnits,
  };
}

export async function syncEntryTransferHistories(
  entryIds: number[],
  endEventId: number,
  options?: { concurrency?: number; season?: string },
): Promise<{
  synced: number;
  errors: number;
  failedEntryIds: number[];
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}> {
  const uniqueEntryIds = uniqueNumbers(entryIds);
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const checkpointSeason = options?.season ?? (await getActiveCacheSeason());
  const sourceCheckedAt = (await readDatabaseOrderingTimestamp()).exact;

  await mapWithConcurrency(uniqueEntryIds, concurrency, async (entryId) => {
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
          sourceCheckedAt,
        }),
        ENTRY_PERSIST_TIMEOUT_MS,
        `Timed out persisting transfer history for entry ${entryId}`,
      );
      return true;
    } catch (error) {
      logError('Failed to sync entry transfer history', error, { entryId, endEventId });
      return false;
    }
  });

  const failedEntryIds = await entryEventTransfersRepository.findEntryIdsNeedingSync(
    uniqueEntryIds,
    endEventId,
    checkpointSeason,
  );
  const synced = uniqueEntryIds.length - failedEntryIds.length;

  return {
    synced,
    errors: failedEntryIds.length,
    failedEntryIds,
    requiredUnits: uniqueEntryIds.length,
    reusedUnits: 0,
    succeededUnits: synced,
    failedUnits: failedEntryIds.length,
  };
}

export async function syncTournamentEventResultsForTournament(
  tournamentId: number,
  eventId: number,
  options?: TournamentEventResultsSyncOptions,
): Promise<
  {
    eventId: number;
    totalEntries: number;
    synced: number;
    errors: number;
  } & TournamentResultWorkSummary
> {
  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(tournamentId);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event results', { tournamentId, eventId });
    return {
      eventId,
      totalEntries: 0,
      synced: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
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
  options?: TournamentEventResultsSyncOptions,
): Promise<
  {
    eventId: number;
    totalEntries: number;
    synced: number;
    errors: number;
    finalizationTargets: TournamentFinalizationTarget[];
  } & TournamentResultWorkSummary
> {
  logInfo('Starting tournament event results sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for tournament event results', { eventId });
    return {
      eventId,
      totalEntries: 0,
      synced: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
      finalizationTargets: [],
    };
  }

  const finalizationTargets = tournaments.flatMap((tournament) =>
    tournament.standingsReadyAt
      ? [{ tournamentId: tournament.id, standingsReadyAt: tournament.standingsReadyAt }]
      : [],
  );

  const entryLists = await mapWithConcurrency(tournaments, 10, (tournament) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id),
  );

  const entryIds = uniqueNumbers(entryLists.flat());
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event results', { eventId });
    return {
      eventId,
      totalEntries: 0,
      synced: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
      finalizationTargets,
    };
  }

  const checkpointSeason = options?.season ?? (await getActiveCacheSeason());
  const sourceOrdering = options?.sourceCheckedAt
    ? {
        date: orderingTimestampDate(options.sourceCheckedAt),
        exact: options.sourceCheckedAt,
      }
    : await readDatabaseOrderingTimestamp();
  const freshAfter = options?.freshAfter
    ? orderingTimestampDate(options.freshAfter)
    : sourceOrdering.date;
  const [existingResults, existingPickEntryIds, requiredTransferEntryIds] = await Promise.all([
    entryEventResultsRepository.findByEventAndEntryIds(eventId, entryIds),
    entryEventPicksRepository.findEntryIdsByEvent(eventId, entryIds, checkpointSeason),
    options?.skipTransfers
      ? Promise.resolve([])
      : entryEventTransfersRepository.findEntryIdsNeedingSync(entryIds, eventId, checkpointSeason),
  ]);
  const freshResultEntryIds = findFreshTournamentResultEntryIds(existingResults, freshAfter);
  const existingPickSet = new Set(existingPickEntryIds);
  const plan = planTournamentEventSync(
    entryIds,
    freshResultEntryIds,
    existingPickSet,
    new Set(requiredTransferEntryIds),
    options?.skipTransfers,
  );
  const { requiredResultEntryIds } = plan;

  await Promise.allSettled([
    requiredResultEntryIds.length > 0
      ? syncTournamentEventResultsForEntryIds(requiredResultEntryIds, eventId, {
          ...options,
          skipTransfers: true,
          season: checkpointSeason,
          freshAfter,
          sourceCheckedAt: sourceOrdering.exact,
        })
      : Promise.resolve(null),
    plan.requiredTransferEntryIds.length > 0
      ? syncEntryTransferHistories(plan.requiredTransferEntryIds, eventId, {
          concurrency: options?.concurrency,
          season: checkpointSeason,
        })
      : Promise.resolve(null),
  ]);

  const [auditedResults, auditedPickEntryIds, missingTransferEntryIds] = await Promise.all([
    entryEventResultsRepository.findByEventAndEntryIds(eventId, entryIds),
    entryEventPicksRepository.findEntryIdsByEvent(eventId, entryIds, checkpointSeason),
    options?.skipTransfers
      ? Promise.resolve([])
      : entryEventTransfersRepository.findEntryIdsNeedingSync(entryIds, eventId, checkpointSeason),
  ]);
  const auditedFreshResultIds = findFreshTournamentResultEntryIds(auditedResults, freshAfter);
  const auditedPickSet = new Set(auditedPickEntryIds);
  const audit = planTournamentEventSync(
    entryIds,
    auditedFreshResultIds,
    auditedPickSet,
    new Set(missingTransferEntryIds),
    options?.skipTransfers,
  );
  const failedUnits = audit.requiredResultEntryIds.length + audit.requiredTransferEntryIds.length;
  const requiredUnits = Math.max(
    requiredResultEntryIds.length + plan.requiredTransferEntryIds.length,
    failedUnits,
  );
  const reusedUnits = plan.reusedUnits;
  const succeededUnits = Math.max(0, requiredUnits - failedUnits);

  if (failedUnits > 0) {
    throw new IncompleteDataSyncError(
      'Tournament event synchronization did not converge for every active entry',
      requiredUnits,
      reusedUnits,
      succeededUnits,
      failedUnits,
    );
  }

  const totalEntries = entryIds.length;
  const synced = requiredResultEntryIds.length;
  const errors = 0;

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
    requiredUnits,
    reusedUnits,
    succeededUnits,
    failedUnits: 0,
    finalizationTargets,
  };
}
