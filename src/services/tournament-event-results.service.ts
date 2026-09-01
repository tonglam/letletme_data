import { readLivePublicationV2 } from '../cache/live-publication-v2';
import { fplClient } from '../clients/fpl';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import { tournamentEntryCoreScopes } from '../domain/mutation-scope';
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
import { eventRepository } from '../repositories/events';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import type { RawFPLEntryTransfersResponse } from '../types';
import { mapWithConcurrency, uniqueNumbers, withTimeout } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';
import type { TournamentFinalizationTarget } from '../domain/tournament';
import { isFreshnessBoundaryNewer, latestFreshnessTimestamp } from '../domain/freshness';
import type { FplSeasonRef } from '../domain/fpl-season';
import { findEventEligibleEntryIds } from '../domain/entry-infos';
import { entryInfoRepository } from '../repositories/entry-infos';
import { getConfig } from '../utils/config';
import { readLivePublicationV2Checkpoint } from './live-publication-v2-checkpoint.service';

const DEFAULT_CONCURRENCY = 5;
const runtimeConfig = getConfig();
const EVENT_LIVE_FETCH_TIMEOUT_MS = runtimeConfig.TOURNAMENT_EVENT_LIVE_TIMEOUT_MS;
const ENTRY_FETCH_TIMEOUT_MS = runtimeConfig.TOURNAMENT_ENTRY_FETCH_TIMEOUT_MS;
const ENTRY_PERSIST_TIMEOUT_MS = runtimeConfig.TOURNAMENT_ENTRY_PERSIST_TIMEOUT_MS;

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
  freshAfter?: Date | string;
  /**
   * Keep each entry's canonical writes in its own short mutation scope.
   * Large catch-up batches must not hold one transaction while processing
   * hundreds of entries: that lets entry-info and result jobs deadlock while
   * each waits on a different entry advisory lock.
   */
  perEntryMutationScopes?: boolean;
};

type TournamentResultWorkSummary = {
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
};

function validateOrderingTimestamp(value: string): string;
function validateOrderingTimestamp(value: Date): Date;
function validateOrderingTimestamp(value: Date | string): Date | string;
function validateOrderingTimestamp(value: Date | string): Date | string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('A valid result freshness timestamp is required');
  }
  return value;
}

function freshEntryIds(entryIds: number[], staleEntryIds: number[]): Set<number> {
  const staleEntryIdSet = new Set(staleEntryIds);
  return new Set(entryIds.filter((entryId) => !staleEntryIdSet.has(entryId)));
}

async function loadEventEligibleEntryIds(
  season: FplSeasonRef,
  entryIds: readonly number[],
  eventId: number,
): Promise<number[]> {
  const uniqueEntryIds = uniqueNumbers(entryIds);
  const entryInfos = await entryInfoRepository.findByIds(season, uniqueEntryIds);
  return findEventEligibleEntryIds(uniqueEntryIds, entryInfos, eventId);
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
  season: FplSeasonRef,
  eventId: number,
  provided?: EventPointsPayload,
): Promise<EventPointsPayload> {
  if (provided) return provided;

  const event = await eventRepository.findById(season, eventId);
  const finalizationBoundary = event?.finished && event.dataChecked && event.dataCheckedAt !== null;

  if (finalizationBoundary) {
    // Once data_checked_at exists, only the complete V2 checkpoint can satisfy
    // the finalized calculation. Do not mix a legacy relational rowset into a
    // V2 publication or allow a final calculation to fetch FPL again.
    const checkpoint = await readLivePublicationV2Checkpoint(season, eventId);
    if (checkpoint?.publication.state === 'FINALIZED' && checkpoint.eventLives.length > 0) {
      return {
        elements: checkpoint.eventLives.map((row) => ({
          id: row.elementId,
          stats: { total_points: row.totalPoints },
        })),
      };
    }
    throw new IncompleteDataSyncError(
      `Final event-live V2 checkpoint is missing for event ${eventId}; wait for final repair`,
      1,
      0,
      0,
      1,
    );
  } else {
    const cached = await readLivePublicationV2({ season: season.seasonCode, eventId }).catch(
      () => null,
    );
    if (cached && cached.eventLives.length > 0) {
      return {
        elements: cached.eventLives.map((row) => ({
          id: row.elementId,
          stats: { total_points: row.totalPoints },
        })),
      };
    }

    const checkpoint = await readLivePublicationV2Checkpoint(season, eventId);
    if (checkpoint && checkpoint.eventLives.length > 0) {
      return {
        elements: checkpoint.eventLives.map((row) => ({
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
  season: FplSeasonRef,
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
  const uniqueEntryIds = await loadEventEligibleEntryIds(season, entryIds, eventId);
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
    ? { exact: validateOrderingTimestamp(options.sourceCheckedAt) }
    : await readDatabaseOrderingTimestamp();
  const sourceFreshAfter = options?.freshAfter
    ? validateOrderingTimestamp(options.freshAfter)
    : sourceOrdering.exact;
  const event = await eventRepository.findById(season, eventId);
  const finalizationDate = event?.finished && event.dataChecked ? event.dataCheckedAt : null;
  const finalizationCutoff = finalizationDate
    ? ((await eventRepository.findDataCheckedAtExact(season, eventId)) ?? finalizationDate)
    : null;
  const freshAfter = latestFreshnessTimestamp(sourceFreshAfter, finalizationCutoff);
  const transferSourceCheckedAt = options?.skipTransfers
    ? null
    : (options?.transferSourceCheckedAt ?? sourceOrdering.exact);
  const live = await resolveEventPointsPayload(season, eventId, options?.live);
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
      const persistEntry = async () => {
        await withTimeout(
          withEntrySeasonSyncTransaction(season, entryId, async (tx) => {
            await createEntryEventResultsRepository(tx).upsertFromPicksAndLive(
              season,
              entryId,
              eventId,
              picks,
              live,
              sourceOrdering.exact,
            );
            await createEntryEventPicksRepository(tx).upsertFromPicks(
              season,
              entryId,
              eventId,
              picks,
              sourceOrdering.exact,
              undefined,
              { preserveCheckpointedInput: true },
            );
          }),
          ENTRY_PERSIST_TIMEOUT_MS,
          `Timed out persisting entry payloads for entry ${entryId}, event ${eventId} after ${ENTRY_PERSIST_TIMEOUT_MS}ms`,
        );
        if (transfers) {
          await entryEventTransfersRepository.replaceForEvent(
            season,
            entryId,
            eventId,
            transfers,
            pointsByElement,
            // The endpoint returned the entrant's complete transfer history.
            // Persist and checkpoint that same scope so the following audit
            // cannot reject a successful backfill repair.
            { sourceCheckedAt: transferSourceCheckedAt! },
          );
        }
      };
      if (options?.perEntryMutationScopes) {
        await withMutationScopes(
          {
            queueName: 'tournament-sync',
            jobName: 'tournament-event-results',
            eventId,
            scopes: tournamentEntryCoreScopes(season.seasonId, [entryId]),
          },
          persistEntry,
        );
      } else {
        await persistEntry();
      }
      return { entryId, success: true } satisfies EntrySyncOutcome;
    } catch (error) {
      logError('Failed to sync tournament entry results', error, { eventId, entryId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  const [staleResultEntryIds, persistedPickEntryIds, missingTransferEntryIds] = await Promise.all([
    entryEventResultsRepository.findEntryIdsNeedingRichSync(
      season,
      uniqueEntryIds,
      eventId,
      freshAfter,
    ),
    entryEventPicksRepository.findEntryIdsByEvent(season, eventId, uniqueEntryIds),
    options?.skipTransfers
      ? Promise.resolve([])
      : entryEventTransfersRepository.findEntryIdsNeedingSync(season, uniqueEntryIds, eventId),
  ]);
  const freshResultEntryIds = freshEntryIds(uniqueEntryIds, staleResultEntryIds);
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
  season: FplSeasonRef,
  entryIds: number[],
  endEventId: number,
  options?: { concurrency?: number; perEntryMutationScopes?: boolean },
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
  const sourceCheckedAt = (await readDatabaseOrderingTimestamp()).exact;

  await mapWithConcurrency(uniqueEntryIds, concurrency, async (entryId) => {
    try {
      const transfers = await withTimeout(
        fplClient.getEntryTransfers(entryId),
        ENTRY_FETCH_TIMEOUT_MS,
        `Timed out fetching transfer history for entry ${entryId}`,
      );
      const persistTransfers = () =>
        withTimeout(
          entryEventTransfersRepository.replaceForEvent(
            season,
            entryId,
            endEventId,
            transfers,
            undefined,
            {
              sourceCheckedAt,
            },
          ),
          ENTRY_PERSIST_TIMEOUT_MS,
          `Timed out persisting transfer history for entry ${entryId}`,
        );
      if (options?.perEntryMutationScopes) {
        await withMutationScopes(
          {
            queueName: 'tournament-sync',
            jobName: 'tournament-event-results',
            eventId: endEventId,
            scopes: tournamentEntryCoreScopes(season.seasonId, [entryId]),
          },
          persistTransfers,
        );
      } else {
        await persistTransfers();
      }
      return true;
    } catch (error) {
      logError('Failed to sync entry transfer history', error, { entryId, endEventId });
      return false;
    }
  });

  const failedEntryIds = await entryEventTransfersRepository.findEntryIdsNeedingSync(
    season,
    uniqueEntryIds,
    endEventId,
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
  season: FplSeasonRef,
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
  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(season, tournamentId);
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

  const result = await syncTournamentEventResultsForEntryIds(season, entryIds, eventId, options);
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
  season: FplSeasonRef,
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

  const tournaments = await tournamentInfoRepository.findActive(season);
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

  const finalizationTargetSeeds = tournaments.flatMap((tournament) =>
    tournament.standingsReadyAt
      ? [{ tournamentId: tournament.id, standingsReadyAt: tournament.standingsReadyAt }]
      : [],
  );

  const entryLists = await mapWithConcurrency(tournaments, 10, (tournament) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(season, tournament.id),
  );

  const entryIds = await loadEventEligibleEntryIds(season, entryLists.flat(), eventId);
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
      finalizationTargets: [],
    };
  }

  const sourceOrdering = options?.sourceCheckedAt
    ? { exact: validateOrderingTimestamp(options.sourceCheckedAt) }
    : await readDatabaseOrderingTimestamp();
  const sourceFreshAfter = options?.freshAfter
    ? validateOrderingTimestamp(options.freshAfter)
    : sourceOrdering.exact;
  const event = await eventRepository.findById(season, eventId);
  const finalizationDate = event?.finished && event.dataChecked ? event.dataCheckedAt : null;
  const finalizationCutoff = finalizationDate
    ? ((await eventRepository.findDataCheckedAtExact(season, eventId)) ?? finalizationDate)
    : null;
  const freshAfter = latestFreshnessTimestamp(sourceFreshAfter, finalizationCutoff);
  const resultsFreshAfter = freshAfter instanceof Date ? freshAfter.toISOString() : freshAfter;
  const finalizationTargets = finalizationTargetSeeds.map((target) => ({
    ...target,
    resultsFreshAfter,
  }));
  const [staleResultEntryIds, existingPickEntryIds, requiredTransferEntryIds] = await Promise.all([
    entryEventResultsRepository.findEntryIdsNeedingRichSync(season, entryIds, eventId, freshAfter),
    entryEventPicksRepository.findEntryIdsByEvent(season, eventId, entryIds),
    options?.skipTransfers
      ? Promise.resolve([])
      : entryEventTransfersRepository.findEntryIdsNeedingSync(season, entryIds, eventId),
  ]);
  const freshResultEntryIds = freshEntryIds(entryIds, staleResultEntryIds);
  const existingPickSet = new Set(existingPickEntryIds);
  const plan = planTournamentEventSync(
    entryIds,
    freshResultEntryIds,
    existingPickSet,
    new Set(requiredTransferEntryIds),
    options?.skipTransfers,
  );
  const { requiredResultEntryIds } = plan;

  // Both operations write the same season/entry transfer fences.  Running
  // them in parallel lets one entry-results transaction hold an entry lock
  // while a transfer transaction holds another, producing a PostgreSQL
  // advisory-lock cycle.  Preserve best-effort auditing, but make the write
  // phases strictly ordered so a transient failure is retried by the caller
  // instead of poisoning the whole batch with 25P02 errors.
  if (requiredResultEntryIds.length > 0) {
    try {
      await syncTournamentEventResultsForEntryIds(season, requiredResultEntryIds, eventId, {
        ...options,
        skipTransfers: true,
        freshAfter,
        sourceCheckedAt: sourceOrdering.exact,
      });
    } catch (error) {
      logError('Tournament result phase did not converge', error, { eventId });
    }
  }
  if (plan.requiredTransferEntryIds.length > 0) {
    try {
      await syncEntryTransferHistories(season, plan.requiredTransferEntryIds, eventId, {
        concurrency: options?.concurrency,
        perEntryMutationScopes: options?.perEntryMutationScopes,
      });
    } catch (error) {
      logError('Tournament transfer phase did not converge', error, { eventId });
    }
  }

  const [auditedStaleResultEntryIds, auditedPickEntryIds, missingTransferEntryIds] =
    await Promise.all([
      entryEventResultsRepository.findEntryIdsNeedingRichSync(
        season,
        entryIds,
        eventId,
        freshAfter,
      ),
      entryEventPicksRepository.findEntryIdsByEvent(season, eventId, entryIds),
      options?.skipTransfers
        ? Promise.resolve([])
        : entryEventTransfersRepository.findEntryIdsNeedingSync(season, entryIds, eventId),
    ]);
  const auditedFreshResultIds = freshEntryIds(entryIds, auditedStaleResultEntryIds);
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

  const postWorkFinalizationCutoff = await eventRepository.findDataCheckedAtExact(season, eventId);
  if (isFreshnessBoundaryNewer(freshAfter, postWorkFinalizationCutoff)) {
    const retryUnits = Math.max(entryIds.length, requiredUnits);
    throw new IncompleteDataSyncError(
      'Tournament event finalized during result sync; retrying with final evidence',
      retryUnits,
      0,
      0,
      retryUnits,
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
