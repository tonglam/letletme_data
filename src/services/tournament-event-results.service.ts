import { randomUUID } from 'node:crypto';

import {
  checkpointEntryLiveInputV2,
  checkpointFinalEntryFromProviderResponse,
  completedFinalEntryIds,
  rebuildFinalEntryLiveInputsV2,
} from './entries.service';
import { readEntryLiveInputV2, readLivePublicationV2 } from '../cache/live-publication-v2';
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
  createEntryEventTransfersRepository,
  withEntrySeasonSyncTransaction,
} from '../repositories/entry-event-transfers';
import { eventRepository } from '../repositories/events';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import type { RawFPLEntryEventPicksResponse, RawFPLEntryTransfersResponse } from '../types';
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
import {
  createSyncOperationsRepository,
  syncOperationsRepository,
} from '../repositories/sync-operations';
import { classifyDataError, safeDataErrorCode } from '../domain/error-classification';
import { withTournamentEntrySyncLease } from '../utils/tournament-entry-sync-lease';

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
   * Retry the FINAL publication for entries whose relational result is already
   * fresh but whose durable V2 checkpoint is incomplete.
   */
  finalizationRecoveryEntryIds?: ReadonlySet<number>;
  /**
   * Keep each entry's canonical writes in its own short mutation scope.
   * Large catch-up batches must not hold one transaction while processing
   * hundreds of entries: that lets entry-info and result jobs deadlock while
   * each waits on a different entry advisory lock.
   */
  perEntryMutationScopes?: boolean;
  /** Durable correlation for entry/GW execution and provider-request audit. */
  auditRunId?: string;
  auditParentRunId?: string;
  auditObligationId?: string;
  auditGeneration?: number;
  auditRepairIssueId?: number;
  auditTrigger?: string;
  auditAttempt?: number;
  auditInitialize?: boolean;
  auditFinalizeRun?: boolean;
};

type TournamentResultWorkSummary = {
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
};

type EntrySyncAuditComponent = 'results' | 'transfers' | 'final';
type EntrySyncAuditOptions = Pick<
  TournamentEventResultsSyncOptions,
  'auditParentRunId' | 'auditObligationId' | 'auditGeneration' | 'auditRepairIssueId'
>;

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

function orderingTimestampString(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function freshEntryIds(entryIds: number[], staleEntryIds: number[]): Set<number> {
  const staleEntryIdSet = new Set(staleEntryIds);
  return new Set(entryIds.filter((entryId) => !staleEntryIdSet.has(entryId)));
}

async function readEntrySyncDurableState(
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
  freshAfter: Date | string,
  finalizationCutoff: Date | string | null,
  checkTransfers: boolean,
): Promise<{
  resultFresh: boolean;
  picksPresent: boolean;
  finalComplete: boolean;
  transfersMissing: boolean;
}> {
  const [staleResults, persistedPickEntryIds, missingTransferEntryIds] = await Promise.all([
    entryEventResultsRepository.findEntryIdsNeedingRichSync(season, [entryId], eventId, freshAfter),
    entryEventPicksRepository.findEntryIdsByEvent(season, eventId, [entryId]),
    checkTransfers
      ? entryEventTransfersRepository.findEntryIdsNeedingSync(season, [entryId], eventId)
      : Promise.resolve([]),
  ]);

  let finalComplete = true;
  if (finalizationCutoff !== null) {
    const heads = await entryEventPicksRepository.findHeadsByEventAndEntryIds(season, eventId, [
      entryId,
    ]);
    const completed = await completedFinalEntryIds(season, eventId, heads, finalizationCutoff);
    finalComplete = completed.has(entryId);
  }

  return {
    resultFresh: staleResults.length === 0,
    picksPresent: persistedPickEntryIds.includes(entryId),
    finalComplete,
    transfersMissing: missingTransferEntryIds.includes(entryId),
  };
}

const ENTRY_EVENT_AUDIT_RESOURCE_TYPE = 'entry-event';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function entryEventAuditResourceId(
  season: FplSeasonRef,
  eventId: number,
  entryId: number,
  component: EntrySyncAuditComponent = 'results',
): string {
  return `${season.seasonId}:${eventId}:${entryId}:${component}`;
}

function auditRunMetadata(
  options: EntrySyncAuditOptions | undefined,
  auditRunId: string,
  auditAttempt: number,
): Record<string, unknown> {
  return {
    auditVersion: 'entry-sync-audit-v1',
    attemptRunId: auditRunId,
    ...(options?.auditParentRunId ? { parentRunId: options.auditParentRunId } : {}),
    ...(options?.auditObligationId ? { obligationId: options.auditObligationId } : {}),
    ...(options?.auditGeneration === undefined
      ? {}
      : { obligationGeneration: options.auditGeneration }),
    ...(options?.auditRepairIssueId === undefined
      ? {}
      : { repairIssueId: options.auditRepairIssueId }),
    bullAttempt: auditAttempt,
  };
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
): Promise<{ payload: EventPointsPayload; providerRequested: boolean }> {
  if (provided) return { payload: provided, providerRequested: false };

  const event = await eventRepository.findById(season, eventId);
  const finalizationBoundary = event?.finished && event.dataChecked && event.dataCheckedAt !== null;

  if (finalizationBoundary) {
    // Once data_checked_at exists, only the complete V2 checkpoint can satisfy
    // the finalized calculation. Do not mix a legacy relational rowset into a
    // V2 publication or allow a final calculation to fetch FPL again.
    const checkpoint = await readLivePublicationV2Checkpoint(season, eventId);
    if (checkpoint?.publication.state === 'FINALIZED' && checkpoint.eventLives.length > 0) {
      return {
        payload: {
          elements: checkpoint.eventLives.map((row) => ({
            id: row.elementId,
            stats: { total_points: row.totalPoints },
          })),
        },
        providerRequested: false,
      };
    }
    throw new IncompleteDataSyncError(
      `Final event-live V2 checkpoint is missing for event ${eventId}; wait for final repair`,
      1,
      0,
      0,
      1,
      'SOURCE_NOT_READY',
    );
  } else {
    const cached = await readLivePublicationV2({ season: season.seasonCode, eventId }).catch(
      () => null,
    );
    if (cached && cached.eventLives.length > 0) {
      return {
        payload: {
          elements: cached.eventLives.map((row) => ({
            id: row.elementId,
            stats: { total_points: row.totalPoints },
          })),
        },
        providerRequested: false,
      };
    }

    const checkpoint = await readLivePublicationV2Checkpoint(season, eventId);
    if (checkpoint && checkpoint.eventLives.length > 0) {
      return {
        payload: {
          elements: checkpoint.eventLives.map((row) => ({
            id: row.elementId,
            stats: { total_points: row.totalPoints },
          })),
        },
        providerRequested: false,
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
  return { payload: live, providerRequested: true };
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

  const auditRunId =
    options?.auditRunId && UUID_PATTERN.test(options.auditRunId)
      ? options.auditRunId
      : randomUUID();
  const auditAttempt = Math.max(1, Math.floor(options?.auditAttempt ?? 1));
  const auditTrigger = options?.auditTrigger ?? 'tournament-event-results';
  if (options?.auditInitialize !== false) {
    await syncOperationsRepository.startRun({
      runId: auditRunId,
      provider: 'fpl',
      lane: 'tournament-sync',
      scope: 'entry-event',
      season,
      eventId,
      mode: 'entry-event-results',
      trigger: auditTrigger,
      expectedItems: uniqueEntryIds.length,
      metadata: auditRunMetadata(options, auditRunId, auditAttempt),
    });
    await syncOperationsRepository.upsertItems(
      auditRunId,
      uniqueEntryIds.map((entryId) => ({
        resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
        resourceId: entryEventAuditResourceId(season, eventId, entryId),
        status: 'pending' as const,
        attempts: auditAttempt,
        normalizedPayload: { phase: 'entry-event-results' },
      })),
    );
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
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const requestedRecoveryEntryIds = new Set(
    [...(options?.finalizationRecoveryEntryIds ?? [])].filter((entryId) =>
      uniqueEntryIds.includes(entryId),
    ),
  );
  const finalizationCheckpointFailureEntryIds = new Set<number>();
  let recoveredFinalEntryIds = new Set<number>();

  // A missing Redis pointer does not imply missing canonical facts. Rebuild
  // those entries from the durable head/result before touching FPL so an
  // outage in the historical endpoint cannot block a cache-only repair.
  if (finalizationDate && finalizationCutoff && requestedRecoveryEntryIds.size > 0) {
    const recoveryIds = [...requestedRecoveryEntryIds];
    try {
      await rebuildFinalEntryLiveInputsV2(
        season,
        eventId,
        recoveryIds,
        finalizationCutoff,
        undefined,
        finalizationCutoff,
      );
      // Rebuild publishes the immutable FINAL candidate. Complete its durable
      // marker from that candidate, still without a provider request.
      await mapWithConcurrency(recoveryIds, 1, async (entryId) => {
        try {
          const current = await readEntryLiveInputV2({
            season: season.seasonCode,
            eventId,
            entryId,
          });
          if (
            current?.servedFrom !== 'REDIS_CURRENT' ||
            current.publication.state !== 'FINAL' ||
            isFreshnessBoundaryNewer(current.publication.sourceCheckedAt, finalizationCutoff)
          ) {
            return false;
          }
          return (await checkpointEntryLiveInputV2(season, eventId, entryId)) === 'checkpointed';
        } catch (error) {
          logError('Durable FINAL recovery marker failed before provider fetch', error, {
            eventId,
            entryId,
          });
          return false;
        }
      });
      const recoveryHeads = await entryEventPicksRepository.findHeadsByEventAndEntryIds(
        season,
        eventId,
        recoveryIds,
      );
      const completedRecoveryIds = await completedFinalEntryIds(
        season,
        eventId,
        recoveryHeads,
        finalizationCutoff,
      );
      recoveredFinalEntryIds = new Set(
        [...completedRecoveryIds].filter((entryId) => requestedRecoveryEntryIds.has(entryId)),
      );
    } catch (error) {
      logError('Durable FINAL recovery before provider fetch did not converge', error, {
        eventId,
        entries: recoveryIds.length,
      });
    }
  }

  // Repair callers may pass the whole tournament roster. Re-plan against the
  // durable result/pick/transfer state before asking FPL for anything so a
  // missing row cannot fan out into a full-roster provider fetch.
  const [plannedStaleResultEntryIds, plannedPersistedPickEntryIds, plannedMissingTransferEntryIds] =
    await Promise.all([
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
  const plannedFreshResultEntryIds = freshEntryIds(uniqueEntryIds, plannedStaleResultEntryIds);
  const plannedPersistedPickSet = new Set(plannedPersistedPickEntryIds);
  const plannedFinalHeads = finalizationDate
    ? await entryEventPicksRepository.findHeadsByEventAndEntryIds(season, eventId, uniqueEntryIds)
    : [];
  const plannedFinalEntryIds = finalizationDate
    ? await completedFinalEntryIds(
        season,
        eventId,
        plannedFinalHeads,
        finalizationCutoff ?? finalizationDate,
      )
    : new Set<number>();
  for (const entryId of recoveredFinalEntryIds) plannedFreshResultEntryIds.add(entryId);
  const requiredResultEntryIds = uniqueEntryIds.filter(
    (entryId) =>
      !recoveredFinalEntryIds.has(entryId) &&
      (!plannedFreshResultEntryIds.has(entryId) ||
        !plannedPersistedPickSet.has(entryId) ||
        (finalizationDate !== null && !plannedFinalEntryIds.has(entryId))),
  );
  const transferOnlyEntryIds = plannedMissingTransferEntryIds.filter(
    (entryId) => !requiredResultEntryIds.includes(entryId),
  );
  const transferEntryIds = new Set(plannedMissingTransferEntryIds);
  const providerEntryIds = requiredResultEntryIds;
  const reusableEntryIds = uniqueEntryIds.filter(
    (entryId) => !requiredResultEntryIds.includes(entryId),
  );
  if (reusableEntryIds.length > 0) {
    await syncOperationsRepository.upsertItems(
      auditRunId,
      reusableEntryIds.map((entryId) => ({
        resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
        resourceId: entryEventAuditResourceId(season, eventId, entryId),
        status: 'skipped' as const,
        attempts: auditAttempt,
        normalizedPayload: {
          phase: 'entry-event-results',
          reused: true,
          reuseReason: recoveredFinalEntryIds.has(entryId)
            ? 'durable-final-recovery'
            : 'durable-fresh',
          sourceRevision: orderingTimestampString(sourceOrdering.exact),
          finalCompletion: finalizationDate !== null,
        },
        completedAt: new Date(),
      })),
    );
  }
  let liveResolution: Awaited<ReturnType<typeof resolveEventPointsPayload>> | null = null;
  try {
    liveResolution =
      providerEntryIds.length > 0
        ? await withTournamentEntrySyncLease(
            // entryId=0 is the event-scoped shared live-source unit. Real FPL
            // entry ids are positive, so it cannot collide with an entry lock.
            { seasonId: season.seasonId, eventId, entryId: 0 },
            () => resolveEventPointsPayload(season, eventId, options?.live),
            {
              leaseMs: Math.max(120_000, EVENT_LIVE_FETCH_TIMEOUT_MS + 15_000),
              waitMs: Math.max(60_000, EVENT_LIVE_FETCH_TIMEOUT_MS + 15_000),
            },
          )
        : null;
  } catch (error) {
    const errorClass = classifyDataError(error);
    await syncOperationsRepository
      .upsertItems(
        auditRunId,
        providerEntryIds.map((entryId) => ({
          resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
          resourceId: entryEventAuditResourceId(season, eventId, entryId),
          status: 'failed' as const,
          attempts: auditAttempt,
          normalizedPayload: {
            phase: 'entry-event-results',
            eventLiveRequests: 1,
            unknownRequests:
              errorClass === 'TRANSIENT_PROVIDER' || errorClass === 'TRANSIENT_INFRA' ? 1 : 0,
          },
          lastError: safeDataErrorCode(error),
        })),
      )
      .catch((auditError) =>
        logError('Failed to persist shared event-live audit failure', auditError, { eventId }),
      );
    await syncOperationsRepository.failRun(auditRunId, new Error(safeDataErrorCode(error)));
    throw error;
  }
  const live = liveResolution?.payload ?? null;
  const eventLiveProviderRequests = liveResolution?.providerRequested ? 1 : 0;
  const pointsByElement = new Map<number, number>();
  if (live) {
    for (const element of live.elements) {
      pointsByElement.set(element.id, element.stats.total_points);
    }
  }
  const acceptedEntryIds = new Set<number>();
  const persistedEntryIds = new Set<number>();
  const coordinatedReuseEntryIds = new Set<number>();
  const picksByEntry = new Map<number, RawFPLEntryEventPicksResponse>();
  await mapWithConcurrency(providerEntryIds, concurrency, async (entryId) => {
    let accepted = false;
    let resultFactsCommitted = false;
    const picksRequest = { started: false, completed: false };
    const transferRequest = { started: false, completed: false };
    const trackedRequest = async <T>(
      state: { started: boolean; completed: boolean },
      request: () => Promise<T>,
    ): Promise<T> => {
      state.started = true;
      const response = await request();
      state.completed = true;
      return response;
    };
    try {
      return await withTournamentEntrySyncLease(
        { seasonId: season.seasonId, eventId, entryId },
        async () => {
          // A different tournament or retry may have completed this entry
          // while the batch was planning. Recheck after the cross-worker lease,
          // immediately before any provider request, so the loser reuses the
          // durable facts instead of issuing the same FPL calls again.
          const durable = await readEntrySyncDurableState(
            season,
            entryId,
            eventId,
            freshAfter,
            finalizationCutoff,
            !options?.skipTransfers && transferEntryIds.has(entryId),
          );
          const needsResult =
            !durable.resultFresh ||
            !durable.picksPresent ||
            (finalizationDate !== null && !durable.finalComplete);
          const needsTransfer =
            !options?.skipTransfers && transferEntryIds.has(entryId) && durable.transfersMissing;

          if (!needsResult && !needsTransfer) {
            coordinatedReuseEntryIds.add(entryId);
            await syncOperationsRepository.upsertItems(auditRunId, [
              {
                resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
                resourceId: entryEventAuditResourceId(season, eventId, entryId),
                status: 'skipped',
                attempts: auditAttempt,
                normalizedPayload: {
                  phase: 'entry-event-results',
                  sourceRevision: orderingTimestampString(sourceOrdering.exact),
                  reuseReason: 'coordinated-durable-complete',
                  finalCompletion: finalizationDate !== null,
                  reused: true,
                },
                completedAt: new Date(),
              },
            ]);
            return { entryId, success: true } satisfies EntrySyncOutcome;
          }

          const [picks, transfers] = await withTimeout(
            Promise.all([
              needsResult
                ? trackedRequest(picksRequest, () => fplClient.getEntryEventPicks(entryId, eventId))
                : Promise.resolve(null),
              !needsTransfer
                ? Promise.resolve(null)
                : options?.transfersByEntry
                  ? options.transfersByEntry.has(entryId)
                    ? Promise.resolve(options.transfersByEntry.get(entryId)!)
                    : Promise.reject(new Error('Transfer payload is missing for requested entry'))
                  : trackedRequest(transferRequest, () => fplClient.getEntryTransfers(entryId)),
            ]),
            ENTRY_FETCH_TIMEOUT_MS,
            `Timed out fetching entry payloads for entry ${entryId}, event ${eventId} after ${ENTRY_FETCH_TIMEOUT_MS}ms`,
          );
          if (picks) picksByEntry.set(entryId, picks);
          if (!picks && !transfers) {
            throw new Error('Entry sync planner requested no provider component');
          }

          const persistEntry = async () => {
            await withEntrySeasonSyncTransaction(
              season,
              entryId,
              async (tx) => {
                const auditItems = [];
                if (picks) {
                  accepted = await createEntryEventResultsRepository(tx).upsertFromPicksAndLive(
                    season,
                    entryId,
                    eventId,
                    picks,
                    live!,
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
                  auditItems.push({
                    resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
                    resourceId: entryEventAuditResourceId(season, eventId, entryId),
                    status: 'completed' as const,
                    attempts: auditAttempt,
                    normalizedPayload: {
                      phase: 'entry-event-results',
                      sourceRevision: orderingTimestampString(sourceOrdering.exact),
                      eventLiveRequests: eventLiveProviderRequests,
                      picksRequests: picksRequest.started ? 1 : 0,
                      transferRequests: 0,
                      factCommit: 'committed',
                      finalCompletion: false,
                      reused: false,
                    },
                    completedAt: new Date(),
                  });
                }
                if (transfers) {
                  await createEntryEventTransfersRepository(tx).replaceForEvent(
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
                  auditItems.push({
                    resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
                    resourceId: entryEventAuditResourceId(season, eventId, entryId, 'transfers'),
                    status: 'completed' as const,
                    attempts: auditAttempt,
                    normalizedPayload: {
                      phase: 'entry-transfer-history',
                      sourceRevision: orderingTimestampString(transferSourceCheckedAt!),
                      eventLiveRequests: 0,
                      picksRequests: 0,
                      transferRequests: transferRequest.started ? 1 : 0,
                      factCommit: 'committed',
                      finalCompletion: false,
                      reused: false,
                    },
                    completedAt: new Date(),
                  });
                }
                await createSyncOperationsRepository(tx).upsertItems(auditRunId, auditItems);
              },
              { timeoutMs: ENTRY_PERSIST_TIMEOUT_MS },
            );
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
          resultFactsCommitted = Boolean(picks);
          if (resultFactsCommitted) persistedEntryIds.add(entryId);
          if (accepted) acceptedEntryIds.add(entryId);
          return { entryId, success: true } satisfies EntrySyncOutcome;
        },
        {
          leaseMs: Math.max(120_000, ENTRY_FETCH_TIMEOUT_MS + ENTRY_PERSIST_TIMEOUT_MS + 30_000),
          waitMs: Math.max(60_000, ENTRY_FETCH_TIMEOUT_MS + ENTRY_PERSIST_TIMEOUT_MS + 30_000),
        },
      );
    } catch (error) {
      await syncOperationsRepository
        .upsertItems(auditRunId, [
          {
            resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
            resourceId: entryEventAuditResourceId(season, eventId, entryId),
            status: 'failed',
            attempts: auditAttempt,
            normalizedPayload: {
              phase: 'entry-event-results',
              picksRequests: picksRequest.started ? 1 : 0,
              transferRequests: transferRequest.started ? 1 : 0,
              unknownRequests:
                (picksRequest.started && !picksRequest.completed ? 1 : 0) +
                (transferRequest.started && !transferRequest.completed ? 1 : 0),
            },
            lastError: safeDataErrorCode(error),
          },
        ])
        .catch((auditError) =>
          logError('Failed to persist entry sync audit failure', auditError, { eventId, entryId }),
        );
      logError('Failed to sync tournament entry results', error, { eventId, entryId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  if (transferOnlyEntryIds.length > 0) {
    await syncEntryTransferHistories(season, transferOnlyEntryIds, eventId, {
      concurrency,
      perEntryMutationScopes: options?.perEntryMutationScopes,
      sourceCheckedAt: transferSourceCheckedAt ?? sourceOrdering.exact,
      auditRunId,
      auditTrigger,
      auditAttempt,
      auditInitialize: false,
      auditFinalizeRun: false,
    });
  }

  // Do not publish any FINAL while provider work can still change the event's
  // finalization fence. The batch boundary check below is the gate; the
  // per-entry helper repeats it immediately before each CAS publication.
  const afterEvent = await eventRepository.findById(season, eventId);
  const afterFinalization =
    afterEvent?.finished && afterEvent.dataChecked ? afterEvent.dataCheckedAt : null;
  const afterCutoff = afterFinalization
    ? ((await eventRepository.findDataCheckedAtExact(season, eventId)) ?? afterFinalization)
    : null;
  const finalizationBoundaryChanged =
    finalizationDate !== null &&
    (!afterCutoff ||
      !finalizationCutoff ||
      isFreshnessBoundaryNewer(finalizationCutoff, afterCutoff) ||
      isFreshnessBoundaryNewer(afterCutoff, finalizationCutoff));
  if (
    finalizationBoundaryChanged ||
    (afterCutoff &&
      (!finalizationCutoff || isFreshnessBoundaryNewer(finalizationCutoff, afterCutoff)))
  ) {
    await syncOperationsRepository.failRun(
      auditRunId,
      new Error(finalizationBoundaryChanged ? 'SOURCE_CHANGED_DURING_SYNC' : 'SOURCE_NOT_READY'),
    );
    throw new IncompleteDataSyncError(
      finalizationBoundaryChanged
        ? 'Event finalization boundary changed during historical sync; fresh source evidence is required'
        : 'Event finalized during historical sync; fresh source evidence is required',
      uniqueEntryIds.length,
      0,
      0,
      uniqueEntryIds.length,
      'SOURCE_CHANGED_DURING_SYNC',
    );
  }

  if (finalizationDate && finalizationCutoff) {
    const finalizationEntryIds = providerEntryIds.filter(
      (entryId) =>
        !coordinatedReuseEntryIds.has(entryId) &&
        (acceptedEntryIds.has(entryId) ||
          persistedEntryIds.has(entryId) ||
          requestedRecoveryEntryIds.has(entryId)),
    );
    await mapWithConcurrency(finalizationEntryIds, concurrency, async (entryId) => {
      const picks = picksByEntry.get(entryId);
      if (!picks || !live) {
        finalizationCheckpointFailureEntryIds.add(entryId);
        return false;
      }
      try {
        await checkpointFinalEntryFromProviderResponse(
          season,
          entryId,
          eventId,
          picks,
          sourceOrdering.exact,
          finalizationCutoff,
          live,
        );
        await syncOperationsRepository.upsertItems(auditRunId, [
          {
            resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
            resourceId: entryEventAuditResourceId(season, eventId, entryId, 'final'),
            status: 'completed',
            attempts: auditAttempt,
            normalizedPayload: {
              phase: 'final-head',
              sourceRevision: orderingTimestampString(sourceOrdering.exact),
              finalCompletion: true,
              reused: false,
            },
            completedAt: new Date(),
          },
        ]);
        return true;
      } catch (error) {
        finalizationCheckpointFailureEntryIds.add(entryId);
        logError('Failed to checkpoint historical FINAL entry', error, { eventId, entryId });
        return false;
      }
    });
  }

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
  // A durable FINAL checkpoint is authoritative for a historical recovery. Its
  // source timestamp may predate this pass's wall-clock freshness probe, but
  // that does not make the already finalized result incomplete again.
  for (const entryId of recoveredFinalEntryIds) freshResultEntryIds.add(entryId);
  const persistedPickSet = new Set(persistedPickEntryIds);
  const missingTransferSet = new Set(missingTransferEntryIds);
  const finalHeads = finalizationDate
    ? await entryEventPicksRepository.findHeadsByEventAndEntryIds(season, eventId, uniqueEntryIds)
    : [];
  const finalEntryIds = finalizationDate
    ? await completedFinalEntryIds(
        season,
        eventId,
        finalHeads,
        finalizationCutoff ?? finalizationDate,
      )
    : new Set<number>();
  const failedEntryIds = uniqueEntryIds.filter(
    (entryId) =>
      (finalizationDate !== null && !finalEntryIds.has(entryId)) ||
      !freshResultEntryIds.has(entryId) ||
      !persistedPickSet.has(entryId) ||
      missingTransferSet.has(entryId) ||
      finalizationCheckpointFailureEntryIds.has(entryId),
  );
  const totalEntries = uniqueEntryIds.length;
  const failedUnits = failedEntryIds.length;
  const synced = totalEntries - failedUnits;
  const errors = failedUnits;
  if (failedUnits > 0) {
    await syncOperationsRepository.failRun(auditRunId, new Error('ENTRY_RESULTS_INCOMPLETE'));
    throw new IncompleteDataSyncError(
      'Tournament event results did not converge for every requested entry',
      totalEntries,
      Math.max(0, totalEntries - requiredResultEntryIds.length - transferOnlyEntryIds.length),
      synced,
      failedUnits,
    );
  }
  if (options?.auditFinalizeRun !== false) {
    await syncOperationsRepository.finishRun(auditRunId, {
      status: 'completed',
      completedItems: synced,
      failedItems: 0,
      skippedItems: reusableEntryIds.length,
      dataChanged: providerEntryIds.length > 0 || transferOnlyEntryIds.length > 0,
      metadata: {
        ...auditRunMetadata(options, auditRunId, auditAttempt),
        finalCompletion: finalizationDate !== null,
        providerEntryCount: providerEntryIds.length,
        transferOnlyEntryCount: transferOnlyEntryIds.length,
      },
    });
  }
  return {
    eventId,
    totalEntries,
    synced,
    errors,
    requiredUnits: totalEntries,
    reusedUnits: Math.max(0, totalEntries - requiredResultEntryIds.length),
    succeededUnits: synced,
    failedUnits,
  };
}

export async function syncEntryTransferHistories(
  season: FplSeasonRef,
  entryIds: number[],
  endEventId: number,
  options?: {
    concurrency?: number;
    perEntryMutationScopes?: boolean;
    auditRunId?: string;
    auditParentRunId?: string;
    auditObligationId?: string;
    auditGeneration?: number;
    auditRepairIssueId?: number;
    auditTrigger?: string;
    auditAttempt?: number;
    auditInitialize?: boolean;
    auditFinalizeRun?: boolean;
    sourceCheckedAt?: Date | string;
  },
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
  const sourceCheckedAt = options?.sourceCheckedAt ?? (await readDatabaseOrderingTimestamp()).exact;
  const auditRunId =
    options?.auditRunId && UUID_PATTERN.test(options.auditRunId)
      ? options.auditRunId
      : randomUUID();
  const auditAttempt = Math.max(1, Math.floor(options?.auditAttempt ?? 1));
  // A zero end-event is the pre-GW sentinel used by roster reconciliation.
  // It is a valid transfer checkpoint, but it is not a valid sync_runs.event_id
  // (the audit table intentionally accepts only real FPL gameweeks). Keep the
  // audit run season-scoped in that case so provider failure/success is still
  // observed without violating the durable event constraint.
  const auditEventId = endEventId > 0 ? endEventId : undefined;
  if (options?.auditInitialize !== false) {
    await syncOperationsRepository.startRun({
      runId: auditRunId,
      provider: 'fpl',
      lane: 'tournament-sync',
      scope: 'entry-event',
      season,
      eventId: auditEventId,
      mode: 'entry-transfer-history',
      trigger: options?.auditTrigger ?? 'tournament-event-transfers',
      expectedItems: uniqueEntryIds.length,
      metadata: auditRunMetadata(options, auditRunId, auditAttempt),
    });
    await syncOperationsRepository.upsertItems(
      auditRunId,
      uniqueEntryIds.map((entryId) => ({
        resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
        resourceId: entryEventAuditResourceId(season, endEventId, entryId, 'transfers'),
        status: 'pending' as const,
        attempts: auditAttempt,
        normalizedPayload: { phase: 'entry-transfer-history' },
      })),
    );
  }

  const reusedTransferEntryIds = new Set<number>();
  await mapWithConcurrency(uniqueEntryIds, concurrency, async (entryId) => {
    const transferRequest = { started: false, completed: false };
    try {
      await withTournamentEntrySyncLease(
        { seasonId: season.seasonId, eventId: endEventId, entryId },
        async () => {
          // Re-plan after the lease: a result repair in another tournament may
          // already have advanced the shared transfer checkpoint.
          const missing = await entryEventTransfersRepository.findEntryIdsNeedingSync(
            season,
            [entryId],
            endEventId,
          );
          if (missing.length === 0) {
            reusedTransferEntryIds.add(entryId);
            await syncOperationsRepository.upsertItems(auditRunId, [
              {
                resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
                resourceId: entryEventAuditResourceId(season, endEventId, entryId, 'transfers'),
                status: 'skipped',
                attempts: auditAttempt,
                normalizedPayload: {
                  phase: 'entry-transfer-history',
                  sourceRevision: orderingTimestampString(sourceCheckedAt),
                  reuseReason: 'coordinated-durable-complete',
                  finalCompletion: false,
                  reused: true,
                },
                completedAt: new Date(),
              },
            ]);
            return;
          }

          transferRequest.started = true;
          const transfers = await withTimeout(
            fplClient.getEntryTransfers(entryId).then((response) => {
              transferRequest.completed = true;
              return response;
            }),
            ENTRY_FETCH_TIMEOUT_MS,
            `Timed out fetching transfer history for entry ${entryId}`,
          );
          const persistTransfers = () =>
            withEntrySeasonSyncTransaction(
              season,
              entryId,
              (tx) =>
                (async () => {
                  await createEntryEventTransfersRepository(tx).replaceForEvent(
                    season,
                    entryId,
                    endEventId,
                    transfers,
                    undefined,
                    { sourceCheckedAt },
                  );
                  await createSyncOperationsRepository(tx).upsertItems(auditRunId, [
                    {
                      resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
                      resourceId: entryEventAuditResourceId(
                        season,
                        endEventId,
                        entryId,
                        'transfers',
                      ),
                      status: 'completed',
                      attempts: auditAttempt,
                      normalizedPayload: {
                        phase: 'entry-transfer-history',
                        sourceRevision: orderingTimestampString(sourceCheckedAt),
                        transferRequests: transferRequest.started ? 1 : 0,
                        factCommit: 'committed',
                        finalCompletion: false,
                        reused: false,
                      },
                      completedAt: new Date(),
                    },
                  ]);
                })(),
              { timeoutMs: ENTRY_PERSIST_TIMEOUT_MS },
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
        },
        {
          leaseMs: Math.max(120_000, ENTRY_FETCH_TIMEOUT_MS + ENTRY_PERSIST_TIMEOUT_MS + 30_000),
          waitMs: Math.max(60_000, ENTRY_FETCH_TIMEOUT_MS + ENTRY_PERSIST_TIMEOUT_MS + 30_000),
        },
      );
      return true;
    } catch (error) {
      await syncOperationsRepository
        .upsertItems(auditRunId, [
          {
            resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
            resourceId: entryEventAuditResourceId(season, endEventId, entryId, 'transfers'),
            status: 'failed',
            attempts: auditAttempt,
            normalizedPayload: {
              phase: 'entry-transfer-history',
              transferRequests: transferRequest.started ? 1 : 0,
              unknownRequests: transferRequest.started && !transferRequest.completed ? 1 : 0,
            },
            lastError: safeDataErrorCode(error),
          },
        ])
        .catch((auditError) =>
          logError('Failed to persist transfer sync audit failure', auditError, {
            endEventId,
            entryId,
          }),
        );
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

  if (options?.auditFinalizeRun !== false) {
    if (failedEntryIds.length > 0) {
      await syncOperationsRepository.failRun(auditRunId, new Error('ENTRY_TRANSFERS_INCOMPLETE'));
    } else {
      await syncOperationsRepository.finishRun(auditRunId, {
        status: 'completed',
        completedItems: synced,
        skippedItems: reusedTransferEntryIds.size,
        dataChanged: uniqueEntryIds.length > reusedTransferEntryIds.size,
        metadata: {
          ...auditRunMetadata(options, auditRunId, auditAttempt),
          phase: 'entry-transfer-history',
        },
      });
    }
  }

  return {
    synced,
    errors: failedEntryIds.length,
    failedEntryIds,
    requiredUnits: uniqueEntryIds.length,
    reusedUnits: reusedTransferEntryIds.size,
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

  const auditRunId =
    options?.auditRunId && UUID_PATTERN.test(options.auditRunId)
      ? options.auditRunId
      : randomUUID();
  const auditTrigger = options?.auditTrigger ?? 'tournament-event-results';
  const auditAttempt = Math.max(1, Math.floor(options?.auditAttempt ?? 1));
  const auditOptions = { ...options, auditRunId, auditTrigger, auditAttempt };
  await syncOperationsRepository.startRun({
    runId: auditRunId,
    provider: 'fpl',
    lane: 'tournament-sync',
    scope: 'entry-event',
    season,
    eventId,
    mode: 'entry-event-results',
    trigger: auditTrigger,
    expectedItems: entryIds.length,
    metadata: auditRunMetadata(options, auditRunId, auditAttempt),
  });
  await syncOperationsRepository.upsertItems(
    auditRunId,
    entryIds.map((entryId) => ({
      resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
      resourceId: entryEventAuditResourceId(season, eventId, entryId),
      status: 'pending' as const,
      attempts: auditAttempt,
      normalizedPayload: { phase: 'entry-event-results' },
    })),
  );

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
  const finalizationRecoveryEntryIds = new Set<number>();
  if (finalizationDate && finalizationCutoff) {
    const finalHeads = await entryEventPicksRepository.findHeadsByEventAndEntryIds(
      season,
      eventId,
      entryIds,
    );
    const completedFinalIds = await completedFinalEntryIds(
      season,
      eventId,
      finalHeads,
      finalizationCutoff,
    );
    for (const entryId of entryIds) {
      if (!completedFinalIds.has(entryId)) finalizationRecoveryEntryIds.add(entryId);
    }
  }
  const requiredResultEntryIds = uniqueNumbers([
    ...plan.requiredResultEntryIds,
    ...finalizationRecoveryEntryIds,
  ]);

  // Both operations write the same season/entry transfer fences. Running them
  // in parallel lets one entry-results transaction hold an entry lock while a
  // transfer transaction holds another, producing an advisory-lock cycle in
  // PostgreSQL. Keep the write phases strictly ordered and propagate a result-phase
  // failure so a missing FINAL checkpoint cannot be reported as success.
  if (requiredResultEntryIds.length > 0) {
    try {
      await syncTournamentEventResultsForEntryIds(season, requiredResultEntryIds, eventId, {
        ...auditOptions,
        skipTransfers: true,
        freshAfter,
        sourceCheckedAt: sourceOrdering.exact,
        finalizationRecoveryEntryIds,
        auditInitialize: false,
        auditFinalizeRun: false,
      });
    } catch (error) {
      logError('Tournament result phase did not converge', error, { eventId });
      throw error;
    }
  }
  if (plan.requiredTransferEntryIds.length > 0) {
    try {
      await syncEntryTransferHistories(season, plan.requiredTransferEntryIds, eventId, {
        concurrency: options?.concurrency,
        perEntryMutationScopes: options?.perEntryMutationScopes,
        auditRunId,
        auditTrigger,
        auditAttempt,
        auditInitialize: false,
        sourceCheckedAt: options?.transferSourceCheckedAt ?? sourceOrdering.exact,
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
  const auditedMissingFinalEntryIds = new Set<number>();
  if (finalizationDate && finalizationCutoff) {
    const auditedFinalHeads = await entryEventPicksRepository.findHeadsByEventAndEntryIds(
      season,
      eventId,
      entryIds,
    );
    const auditedCompletedFinalIds = await completedFinalEntryIds(
      season,
      eventId,
      auditedFinalHeads,
      finalizationCutoff,
    );
    for (const entryId of entryIds) {
      if (!auditedCompletedFinalIds.has(entryId)) auditedMissingFinalEntryIds.add(entryId);
    }
    // A cache-only recovery can legitimately reuse an older, complete durable
    // result. The FINAL checkpoint is the authoritative completion evidence;
    // do not make the outer freshness audit refetch a provider result merely
    // because its rich-sync timestamp predates this planner pass.
    for (const entryId of auditedCompletedFinalIds) {
      if (finalizationRecoveryEntryIds.has(entryId)) auditedFreshResultIds.add(entryId);
    }
  }
  const audit = planTournamentEventSync(
    entryIds,
    auditedFreshResultIds,
    auditedPickSet,
    new Set(missingTransferEntryIds),
    options?.skipTransfers,
  );
  const failedResultEntryIds = new Set([
    ...audit.requiredResultEntryIds,
    ...auditedMissingFinalEntryIds,
  ]);
  const failedUnits = failedResultEntryIds.size + audit.requiredTransferEntryIds.length;
  const requiredUnits = Math.max(
    requiredResultEntryIds.length + plan.requiredTransferEntryIds.length,
    failedUnits,
  );
  const reusedUnits = plan.reusedUnits;
  const succeededUnits = Math.max(0, requiredUnits - failedUnits);

  if (failedUnits > 0) {
    await syncOperationsRepository.failRun(auditRunId, new Error('ENTRY_EVENT_SYNC_INCOMPLETE'));
    throw new IncompleteDataSyncError(
      'Tournament event synchronization did not converge for every active entry',
      requiredUnits,
      reusedUnits,
      succeededUnits,
      failedUnits,
    );
  }

  const postWorkEvent = await eventRepository.findById(season, eventId);
  const postWorkFinalizationCutoff =
    postWorkEvent?.finished && postWorkEvent.dataChecked
      ? ((await eventRepository.findDataCheckedAtExact(season, eventId)) ??
        postWorkEvent.dataCheckedAt)
      : null;
  const postWorkBoundaryChanged =
    finalizationDate !== null &&
    (!postWorkFinalizationCutoff ||
      !finalizationCutoff ||
      isFreshnessBoundaryNewer(finalizationCutoff, postWorkFinalizationCutoff) ||
      isFreshnessBoundaryNewer(postWorkFinalizationCutoff, finalizationCutoff));
  if (postWorkBoundaryChanged || isFreshnessBoundaryNewer(freshAfter, postWorkFinalizationCutoff)) {
    const retryUnits = Math.max(entryIds.length, requiredUnits);
    await syncOperationsRepository.failRun(auditRunId, new Error('SOURCE_CHANGED_DURING_SYNC'));
    throw new IncompleteDataSyncError(
      postWorkBoundaryChanged
        ? 'Tournament event finalized during result sync; finalization boundary changed, retrying with final evidence'
        : 'Tournament event finalized during result sync; retrying with final evidence',
      retryUnits,
      0,
      0,
      retryUnits,
      'SOURCE_CHANGED_DURING_SYNC',
    );
  }

  const totalEntries = entryIds.length;
  const synced = requiredResultEntryIds.length;
  const errors = 0;

  await syncOperationsRepository.upsertItems(
    auditRunId,
    entryIds.map((entryId) => ({
      resourceType: ENTRY_EVENT_AUDIT_RESOURCE_TYPE,
      resourceId: entryEventAuditResourceId(season, eventId, entryId),
      status: 'skipped' as const,
      attempts: auditAttempt,
      normalizedPayload: {
        phase: 'entry-event-results',
        reused: true,
        reuseReason: 'outer-convergence-audit',
        finalCompletion: finalizationDate !== null,
      },
      completedAt: new Date(),
    })),
  );
  const changedEntryIds = new Set([...requiredResultEntryIds, ...plan.requiredTransferEntryIds]);
  const reusedAuditUnits = Math.max(0, entryIds.length - changedEntryIds.size);
  await syncOperationsRepository.finishRun(auditRunId, {
    status: 'completed',
    completedItems: Math.max(0, changedEntryIds.size - failedUnits),
    failedItems: 0,
    skippedItems: reusedAuditUnits,
    dataChanged: requiredResultEntryIds.length > 0 || plan.requiredTransferEntryIds.length > 0,
    metadata: {
      ...auditRunMetadata(options, auditRunId, auditAttempt),
      finalCompletion: finalizationDate !== null,
      providerEntryCount: requiredResultEntryIds.length,
      transferEntryCount: plan.requiredTransferEntryIds.length,
    },
  });

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
