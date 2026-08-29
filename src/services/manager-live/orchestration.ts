// Manager Live orchestration implementation. Kept behind the compatibility facade.
import type Redis from 'ioredis';
import type { redisSingleton } from '../../cache/singleton';
import type { eventRepository } from '../../repositories/events';
import type { seasonRepository } from '../../repositories/seasons';
import type { tournamentEntryRepository } from '../../repositories/tournament-entries';
import type { tournamentInfoRepository } from '../../repositories/tournament-infos';
import type { entryInfoRepository } from '../../repositories/entry-infos';
import type {
  managerScoreCheckpointRepository,
  ManagerScoreScope,
} from '../../repositories/live-window';
import { ValidationError } from '../../utils/errors';
import { logDebug, logWarn } from '../../utils/logger';
import {
  finalManagerRevision,
  isFinalManagerLiveRevision,
  tournamentRosterRevision,
} from '../../domain/manager-live-coverage';
import {
  MANAGER_LIVE_CLASSIC_CAPPED_CURSOR,
  MANAGER_LIVE_WORKER_CLASSIC_OR_FETCH_LIMIT,
  MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT,
  MANAGER_LIVE_WORKER_REQUEST_DEADLINE_MS,
  MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT,
  classicStandingsCursorAfterRefresh,
  managerLiveRosterRevision,
} from '../../domain/manager-live-refresh';
import {
  classicManagerBackgroundStandingsStartPage,
  classicManagerSummaryFallbackEntryIds,
  classicManagerSummaryFallbackNeedsRefresh,
  managerLiveBackgroundRefreshKey,
  managerSummaryFetchBatches,
  nextManagerLiveStandingsContinuation,
  pendingManagerRefreshEntryIds,
  planClassicManagerFallback,
  planManagerLiveRefreshTargets,
  rotateManagerLiveEntryIds,
  runManagerStandingsPageSequence,
  selectForegroundClassicRankEntryIds,
  shouldEnrichClassicOverallRank,
  shouldRefreshClassicOverallRank,
} from '../../domain/manager-live-fallback';
import type { readManagerScoreHeadRowsWithSource } from '../../repositories/manager-score-materializations';
import type {
  ManagerLiveCalculationMode,
  ManagerLiveReadMode,
  ManagerLiveResolveResult,
} from './contracts';
import {
  invalidateManagerLiveTournamentCoverage,
  shouldQueueFinalizedManagerLiveCoverage,
} from './coverage';
import { selectFinalizedManagerLiveEntryIds } from './row-model';
import {
  CachedRow,
  EntrySummaryRefreshResult,
  INCOMPLETE_CLASSIC_REFRESH_SECONDS,
  MAX_BACKGROUND_STANDINGS_PAGES,
  MAX_FOREGROUND_OVERALL_RANK_FETCHES,
  MAX_FOREGROUND_SUMMARY_FETCHES,
  MAX_STANDINGS_PAGES,
  ManagerLiveRowBacking,
  REFRESH_SECONDS,
  classicStandingNeedsOverallRank,
  entryScope,
  fromManagerScoreCheckpoint,
  mergeClassicStandingWithEntrySummary,
  mergeLatestRows,
  scopeKey,
} from './publication-store';
import type { readBackgroundRows, readCachedAndCheckpointRows } from './publication-store';
import { isFresh, isWithinStaleWindow, managerRevision } from './result-assembly';
import {
  ManagerLiveLeaseOwnershipError,
  runClassicStandingsRefresh,
  scheduleBackgroundRefresh,
  selectClassicOverallRankRefreshTargets,
  selectWorkerClassicFallbackTargets,
  selectWorkerSummaryRefreshTargets,
  tournamentRosterLifecycleMarker,
} from './provider-refresh';
import { nextRefresh, workerProjectionEntryIds } from './final-result-projection';
import type {
  buildActiveManagerLiveResult,
  buildManagerLiveResult,
  materializedProjectedRows,
  persistTournamentCoverage,
  readTournamentCoverage,
} from './result-assembly';
import type {
  dispatchManagerLiveRefreshBounded,
  refreshClassicStandings,
  refreshEntrySummaries,
} from './provider-refresh';
import type { finalResultRows } from './final-result-projection';

export type ManagerLiveOrchestrationDependencies = {
  clock: { now(): Date };
  redisSingleton: Pick<typeof redisSingleton, 'getClient'>;
  eventRepository: Pick<typeof eventRepository, 'findById'>;
  seasonRepository: Pick<typeof seasonRepository, 'findCurrent'>;
  tournamentEntryRepository: Pick<typeof tournamentEntryRepository, 'findEntryIdsByTournamentId'>;
  tournamentInfoRepository: Pick<typeof tournamentInfoRepository, 'findById'>;
  entryInfoRepository: Pick<typeof entryInfoRepository, 'findByIds'>;
  managerScoreCheckpointRepository: Pick<
    typeof managerScoreCheckpointRepository,
    'findByScopeAndEntryIds'
  >;
  readManagerScoreHeadRowsWithSource: typeof readManagerScoreHeadRowsWithSource;
  readCachedAndCheckpointRows: typeof readCachedAndCheckpointRows;
  readBackgroundRows: typeof readBackgroundRows;
  readTournamentCoverage: typeof readTournamentCoverage;
  persistTournamentCoverage: typeof persistTournamentCoverage;
  buildActiveManagerLiveResult: typeof buildActiveManagerLiveResult;
  buildManagerLiveResult: typeof buildManagerLiveResult;
  materializedProjectedRows: typeof materializedProjectedRows;
  refreshClassicStandings: typeof refreshClassicStandings;
  refreshEntrySummaries: typeof refreshEntrySummaries;
  dispatchManagerLiveRefreshBounded: typeof dispatchManagerLiveRefreshBounded;
  finalResultRows: typeof finalResultRows;
};

export const resolveManagerLiveScoresUncoalesced = async (
  input: {
    eventId: number;
    entryIds: readonly number[];
    tournamentId?: number;
    readMode?: ManagerLiveReadMode;
    includeEffectiveLineup?: boolean;
    liveRef?: { publicationId: string; revision: number | string };
    requestedCalculationMode?: Exclude<ManagerLiveCalculationMode, 'FINAL_RESULT'>;
    completeRefresh?: boolean;
    classicStandingsStartPage?: number;
    summaryRotationCursor?: number;
  },
  dependencies: ManagerLiveOrchestrationDependencies,
): Promise<ManagerLiveResolveResult> => {
  const {
    redisSingleton,
    eventRepository,
    seasonRepository,
    tournamentEntryRepository,
    tournamentInfoRepository,
    entryInfoRepository,
    managerScoreCheckpointRepository,
    readManagerScoreHeadRowsWithSource,
    readCachedAndCheckpointRows,
    readBackgroundRows,
    readTournamentCoverage,
    persistTournamentCoverage,
    buildActiveManagerLiveResult,
    buildManagerLiveResult,
    materializedProjectedRows,
    refreshClassicStandings,
    refreshEntrySummaries,
    dispatchManagerLiveRefreshBounded,
    finalResultRows,
  } = dependencies;
  const nowIso = (): string => dependencies.clock.now().toISOString();
  const season = await seasonRepository.findCurrent();
  const requestedEntryIds = Array.from(new Set(input.entryIds));
  const workerTournamentRefresh =
    input.completeRefresh === true && input.tournamentId !== undefined;
  if (
    !Number.isSafeInteger(input.eventId) ||
    input.eventId <= 0 ||
    requestedEntryIds.length === 0 ||
    (!workerTournamentRefresh && requestedEntryIds.length > 500) ||
    requestedEntryIds.some((entryId) => !Number.isSafeInteger(entryId) || entryId <= 0)
  ) {
    throw new ValidationError('Invalid manager live request.', 'MANAGER_LIVE_REQUEST_INVALID');
  }

  const event = await eventRepository.findById(season, input.eventId);
  if (!event) {
    throw new ValidationError(
      'Event does not belong to the active season.',
      'MANAGER_LIVE_EVENT_INVALID',
    );
  }

  let scope: ManagerScoreScope = entryScope;
  let tournament: Awaited<ReturnType<typeof tournamentInfoRepository.findById>> = null;
  let authoritativeTournamentRosterEntryIds: number[] | null = null;
  if (input.tournamentId !== undefined) {
    tournament = await tournamentInfoRepository.findById(season, input.tournamentId);
    if (!tournament) {
      throw new ValidationError(
        'Tournament does not belong to the active season.',
        'MANAGER_LIVE_TOURNAMENT_INVALID',
      );
    }
    const rosterEntryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(
      season,
      input.tournamentId,
    );
    authoritativeTournamentRosterEntryIds = rosterEntryIds;
    const roster = new Set(rosterEntryIds);
    if (!workerTournamentRefresh && requestedEntryIds.some((entryId) => !roster.has(entryId))) {
      throw new ValidationError(
        'Entry is not a member of the tournament.',
        'MANAGER_LIVE_ENTRY_NOT_IN_TOURNAMENT',
      );
    }
    // Public resolve remains capped at 500. The background worker is the only
    // caller allowed to expand a tournament scope, and it re-reads the
    // authoritative roster on every run so a roster revision cannot leave the
    // crawl pinned to the first request's window.
    if (workerTournamentRefresh) {
      requestedEntryIds.splice(0, requestedEntryIds.length, ...rosterEntryIds);
    }
    if (tournament.leagueType === 'classic') {
      scope = { scopeType: 'CLASSIC_LEAGUE', scopeId: tournament.leagueId };
    }
  }

  const uniqueEntryIds = requestedEntryIds;

  const existingTournamentCoverage =
    input.tournamentId === undefined
      ? null
      : await readTournamentCoverage(season, input.eventId, input.tournamentId);
  const coverageRosterEntryIds = authoritativeTournamentRosterEntryIds ?? uniqueEntryIds;
  const currentTournamentRosterRevision =
    input.tournamentId === undefined ? null : tournamentRosterRevision(coverageRosterEntryIds);
  const currentTournamentHotRosterRevision =
    input.tournamentId === undefined
      ? undefined
      : managerLiveRosterRevision(
          coverageRosterEntryIds,
          tournamentRosterLifecycleMarker(tournament),
        );

  // Once the event is finalized, only entries that were eligible for that
  // event belong in the result denominator. The authoritative tournament
  // roster can legitimately contain late entrants whose earlier GW rows do
  // not exist. Resolve the eligibility set once and reuse it for both the
  // public response and durable tournament coverage.
  const finalizedEligibility =
    event.finished && event.dataChecked
      ? selectFinalizedManagerLiveEntryIds(
          input.tournamentId === undefined ? uniqueEntryIds : coverageRosterEntryIds,
          await entryInfoRepository.findByIds(
            season,
            input.tournamentId === undefined ? uniqueEntryIds : coverageRosterEntryIds,
          ),
          input.eventId,
        )
      : null;
  const finalizedCoverageEntryIds =
    input.tournamentId === undefined
      ? (finalizedEligibility?.eligibleEntryIds ?? uniqueEntryIds)
      : (finalizedEligibility?.eligibleEntryIds ?? coverageRosterEntryIds);
  const finalizedCoverageEntryIdSet = new Set(finalizedCoverageEntryIds);
  const finalizedRequestedEntryIds = uniqueEntryIds.filter((entryId) =>
    finalizedCoverageEntryIdSet.has(entryId),
  );
  if (finalizedEligibility && finalizedEligibility.notApplicableEntryIds.length > 0) {
    logDebug('Excluded not-applicable finalized manager live entries', {
      eventId: input.eventId,
      tournamentId: input.tournamentId ?? null,
      requestedEntries: uniqueEntryIds.length,
      coverageEntries: coverageRosterEntryIds.length,
      eligibleEntries: finalizedCoverageEntryIds.length,
      notApplicableEntries: finalizedEligibility.notApplicableEntryIds.length,
    });
  }
  const tournamentCoverage = currentTournamentRosterRevision
    ? invalidateManagerLiveTournamentCoverage(
        existingTournamentCoverage,
        currentTournamentRosterRevision,
        finalizedCoverageEntryIds.length,
      )
    : existingTournamentCoverage;

  // A finished/data-checked event is historical data. Do not call the current
  // FPL manager endpoint for it; the final result table is the authority.
  if (event.finished && event.dataChecked) {
    if (!event.dataCheckedAt) {
      return buildManagerLiveResult({
        season: season.seasonCode,
        eventId: input.eventId,
        rows: [],
        missingEntryIds: finalizedRequestedEntryIds,
        errorCode: 'UPSTREAM_UNAVAILABLE',
        checkedAt: nowIso(),
        nextRefreshAt: nextRefresh(true),
        sourceByEntry: new Map(),
        calculationMode: 'FINAL_RESULT',
      });
    }
    const finalRows = await finalResultRows(
      season,
      input.eventId,
      finalizedRequestedEntryIds,
      event.dataCheckedAt,
      input.includeEffectiveLineup === true,
    );
    const resolvedIds = new Set(finalRows.map((row) => row.entryId));
    const finalErrorCode =
      resolvedIds.size === finalizedRequestedEntryIds.length
        ? null
        : ('UPSTREAM_UNAVAILABLE' as const);
    const projectionEntryIds = workerProjectionEntryIds(
      finalizedRequestedEntryIds,
      workerTournamentRefresh,
    );
    const projectionEntryIdSet = new Set(projectionEntryIds);
    const projectedFinalRows = finalRows.filter((row) => projectionEntryIdSet.has(row.entryId));
    const projectedResolvedIds = new Set(projectedFinalRows.map((row) => row.entryId));
    let currentFinalManagerRevision: string | undefined;
    if (
      input.tournamentId !== undefined &&
      currentTournamentRosterRevision !== null &&
      tournamentCoverage?.state === 'COMPLETE' &&
      isFinalManagerLiveRevision(tournamentCoverage.managerRevision)
    ) {
      const requestedEntryIdSet = new Set(finalizedRequestedEntryIds);
      const requestedTheFullRoster =
        finalizedCoverageEntryIds.length === finalizedRequestedEntryIds.length &&
        finalizedCoverageEntryIds.every((entryId) => requestedEntryIdSet.has(entryId));
      const coverageFinalRows = requestedTheFullRoster
        ? finalRows
        : await finalResultRows(
            season,
            input.eventId,
            finalizedCoverageEntryIds,
            event.dataCheckedAt,
            false,
          );
      const coverageResolvedIds = new Set(coverageFinalRows.map((row) => row.entryId));
      currentFinalManagerRevision = finalManagerRevision(
        managerRevision(
          season.seasonCode,
          input.eventId,
          coverageFinalRows,
          finalizedCoverageEntryIds.filter((entryId) => !coverageResolvedIds.has(entryId)),
        ),
      );
    }
    let refreshQueued = false;
    if (
      input.tournamentId !== undefined &&
      !workerTournamentRefresh &&
      currentTournamentRosterRevision !== null &&
      shouldQueueFinalizedManagerLiveCoverage(
        tournamentCoverage,
        currentTournamentRosterRevision,
        finalizedCoverageEntryIds.length,
        currentFinalManagerRevision,
      )
    ) {
      try {
        refreshQueued =
          (await dispatchManagerLiveRefreshBounded({
            season,
            eventId: input.eventId,
            entryIds: coverageRosterEntryIds,
            tournamentId: input.tournamentId,
            rosterRevision: currentTournamentHotRosterRevision,
          })) === 'QUEUED';
      } catch (error) {
        logWarn('Finalized manager live coverage dispatch failed', {
          eventId: input.eventId,
          tournamentId: input.tournamentId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    const result = buildManagerLiveResult({
      season: season.seasonCode,
      eventId: input.eventId,
      rows: projectedFinalRows,
      // Once FPL marks the event data_checked, an older active/summary/league
      // checkpoint is no longer a valid score fallback. Missing finalized rows
      // stay unavailable until the persisted official result arrives.
      missingEntryIds: projectionEntryIds.filter((entryId) => !projectedResolvedIds.has(entryId)),
      errorCode: finalErrorCode,
      checkedAt: nowIso(),
      nextRefreshAt: nextRefresh(true),
      sourceByEntry: new Map(finalRows.map((row) => [row.entryId, 'POSTGRES' as const])),
      refreshQueued,
      ...(input.tournamentId === undefined ? {} : { tournamentCoverage }),
      calculationMode: 'FINAL_RESULT',
    });
    if (workerTournamentRefresh && input.tournamentId !== undefined) {
      const fullMissingEntryIds = finalizedCoverageEntryIds.filter(
        (entryId) => !resolvedIds.has(entryId),
      );
      const fullManagerRevision = managerRevision(
        season.seasonCode,
        input.eventId,
        finalRows,
        fullMissingEntryIds,
      );
      result.managerRevision = fullManagerRevision;
      const finalCoverageRosterRevision = tournamentRosterRevision(coverageRosterEntryIds);
      const persistedCoverage = await persistTournamentCoverage({
        season,
        eventId: input.eventId,
        tournamentId: input.tournamentId,
        rosterRevision: finalCoverageRosterRevision,
        expectedEntries: finalizedCoverageEntryIds.length,
        rows: finalRows,
        errorCode: finalErrorCode,
        managerRevision: finalManagerRevision(fullManagerRevision),
        crawlComplete: resolvedIds.size === finalizedCoverageEntryIds.length,
      });
      result.tournamentCoverage = persistedCoverage;
      if (!persistedCoverage) {
        // A finalized result is not successful until its tournament coverage
        // is durable. Keep the worker continuation and Bull retry eligible
        // instead of treating an in-memory COMPLETE candidate as published.
        result.errorCode = result.errorCode ?? 'UPSTREAM_UNAVAILABLE';
      }
    }
    return result;
  }

  // CACHE_ONLY is a materialization/head read. It never invokes the projector
  // or reads the legacy score checkpoint; a miss only schedules a refresh.
  if ((input.readMode ?? 'READ_THROUGH') === 'CACHE_ONLY') {
    const sourceByEntry = new Map<number, ManagerLiveRowBacking>();
    let refreshQueued = false;
    try {
      const dispatchState = await dispatchManagerLiveRefreshBounded({
        season,
        eventId: input.eventId,
        entryIds: coverageRosterEntryIds,
        ...(input.tournamentId === undefined ? {} : { tournamentId: input.tournamentId }),
        ...(currentTournamentHotRosterRevision === undefined
          ? {}
          : { rosterRevision: currentTournamentHotRosterRevision }),
      });
      refreshQueued = dispatchState === 'QUEUED';
    } catch (error) {
      logWarn('Projected manager cache-only response could not queue a refresh', {
        eventId: input.eventId,
        tournamentId: input.tournamentId ?? null,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    if (input.requestedCalculationMode === 'OFFICIAL_CURRENT_MULTIPLIERS') {
      return buildManagerLiveResult({
        season: season.seasonCode,
        eventId: input.eventId,
        rows: [],
        missingEntryIds: uniqueEntryIds,
        errorCode: 'INPUT_INCOMPLETE',
        nextRefreshAt: nextRefresh(event.finished),
        sourceByEntry,
        refreshQueued,
        checkedAt: nowIso(),
        calculationMode: 'OFFICIAL_CURRENT_MULTIPLIERS',
        ...(input.tournamentId === undefined ? {} : { tournamentCoverage }),
      });
    }

    let projectedRows: CachedRow[] = [];
    let rankMetadataRows: CachedRow[] = [];
    let rankMetadataRedis: Redis | null = null;
    try {
      rankMetadataRedis = await redisSingleton.getClient();
    } catch (error) {
      logWarn('Rank metadata Redis unavailable in cache-only mode', {
        eventId: input.eventId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    try {
      const metadata = await readCachedAndCheckpointRows(
        rankMetadataRedis,
        season,
        input.eventId,
        scope,
        uniqueEntryIds,
      );
      rankMetadataRows = [...metadata.values()];
    } catch (error) {
      logWarn('Rank metadata read failed in cache-only mode', {
        eventId: input.eventId,
        entries: uniqueEntryIds.length,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    try {
      const projectedHeadRead = await readManagerScoreHeadRowsWithSource(
        season,
        input.eventId,
        uniqueEntryIds,
        'PROJECTED_AUTOSUBS',
      );
      projectedRows = materializedProjectedRows(
        season.seasonCode,
        input.eventId,
        uniqueEntryIds,
        projectedHeadRead.rows,
        input.includeEffectiveLineup === true,
        input.liveRef,
        rankMetadataRows,
      );
      for (const row of projectedRows) {
        sourceByEntry.set(
          row.entryId,
          projectedHeadRead.sourceByEntry.get(row.entryId) ?? 'POSTGRES',
        );
      }
    } catch (error) {
      logWarn('Projected manager materialization read failed in cache-only mode', {
        eventId: input.eventId,
        entries: uniqueEntryIds.length,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    const projectedIds = new Set(projectedRows.map((row) => row.entryId));
    const revisionUnavailable =
      input.liveRef !== undefined && projectedIds.size !== uniqueEntryIds.length;
    return buildManagerLiveResult({
      season: season.seasonCode,
      eventId: input.eventId,
      rows: projectedRows,
      missingEntryIds: uniqueEntryIds.filter((entryId) => !projectedIds.has(entryId)),
      errorCode:
        projectedRows.length === uniqueEntryIds.length
          ? null
          : revisionUnavailable
            ? 'REVISION_UNAVAILABLE'
            : 'INPUT_INCOMPLETE',
      nextRefreshAt: nextRefresh(event.finished),
      sourceByEntry,
      refreshQueued,
      checkedAt:
        projectedRows.length > 0 ? projectedRows.map((row) => row.checkedAt).sort()[0] : nowIso(),
      calculationMode: 'PROJECTED_AUTOSUBS',
      ...(input.tournamentId === undefined ? {} : { tournamentCoverage }),
    });
  }

  let redis: Redis | null = null;
  try {
    redis = await redisSingleton.getClient();
  } catch (error) {
    logWarn('Official manager Redis unavailable; using PostgreSQL checkpoint', {
      eventId: input.eventId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
  const sourceByEntry = new Map<number, ManagerLiveRowBacking>();
  const rows = await readCachedAndCheckpointRows(
    redis,
    season,
    input.eventId,
    scope,
    uniqueEntryIds,
    undefined,
    sourceByEntry,
  );
  const initialRevisionByEntry = new Map(
    [...rows].map(([entryId, row]) => [entryId, `${row.revision}:${row.checkedAt}`] as const),
  );

  const staleOrMissingForWorker = uniqueEntryIds.filter(
    (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
  );

  const completeRefresh = input.completeRefresh === true;
  if (completeRefresh) {
    let refreshErrorCode: Exclude<
      ManagerLiveResolveResult['errorCode'],
      'UNSUPPORTED_H2H_LIVE' | null
    > | null = null;
    let classicStandingsNextPage: number | null | undefined;
    let workerSummaryBudget = MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT;
    const workerRotationCursor =
      Number.isSafeInteger(input.summaryRotationCursor) && (input.summaryRotationCursor ?? 0) >= 0
        ? input.summaryRotationCursor!
        : 0;
    const takeWorkerSummaryTargets = (entryIds: readonly number[], limit = workerSummaryBudget) => {
      const selected = selectWorkerSummaryRefreshTargets(
        entryIds,
        Math.min(workerSummaryBudget, limit),
        workerRotationCursor,
      );
      workerSummaryBudget -= selected.length;
      return selected;
    };
    const workerRequestDeadlineMs = MANAGER_LIVE_WORKER_REQUEST_DEADLINE_MS;

    if (input.tournamentId !== undefined && tournament?.leagueType === 'classic') {
      if (!tournament) throw new Error('Tournament validation unexpectedly missing');
      const standingsTargetIds = workerTournamentRefresh ? uniqueEntryIds : staleOrMissingForWorker;
      const startPage =
        Number.isSafeInteger(input.classicStandingsStartPage) &&
        (input.classicStandingsStartPage ?? 0) >= 1 &&
        (input.classicStandingsStartPage ?? 0) <= MANAGER_LIVE_CLASSIC_CAPPED_CURSOR
          ? input.classicStandingsStartPage!
          : 1;
      const standings = await refreshClassicStandings(
        season,
        input.eventId,
        tournament.leagueId,
        new Set(standingsTargetIds),
        rows,
        redis,
        {
          startPage,
          maxPages: MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT,
          requestDeadlineMs: workerRequestDeadlineMs,
        },
      );
      refreshErrorCode = standings.errorCode;
      classicStandingsNextPage = classicStandingsCursorAfterRefresh(true, standings);

      const overallRankTargets = selectClassicOverallRankRefreshTargets(
        uniqueEntryIds,
        rows,
        MANAGER_LIVE_WORKER_CLASSIC_OR_FETCH_LIMIT,
        workerRotationCursor,
      );
      const selectedOverallRankTargets = takeWorkerSummaryTargets(
        overallRankTargets,
        MANAGER_LIVE_WORKER_CLASSIC_OR_FETCH_LIMIT,
      );
      if (selectedOverallRankTargets.length > 0) {
        const summaryRefresh = await refreshEntrySummaries(
          season,
          input.eventId,
          selectedOverallRankTargets,
          rows,
          redis,
          { scopeType: 'CLASSIC_LEAGUE', scopeId: tournament.leagueId },
          {
            maxFetches: selectedOverallRankTargets.length,
            force: true,
            preserveClassicStanding: true,
            requestDeadlineMs: workerRequestDeadlineMs,
          },
        );
        refreshErrorCode = refreshErrorCode ?? summaryRefresh.errorCode;
      }

      const fallbackTargets = selectWorkerClassicFallbackTargets(
        staleOrMissingForWorker,
        rows,
        standings.complete,
      );
      const selectedFallbackTargets = takeWorkerSummaryTargets(fallbackTargets);
      if (selectedFallbackTargets.length > 0) {
        const summaryRefresh = await refreshEntrySummaries(
          season,
          input.eventId,
          selectedFallbackTargets,
          rows,
          redis,
          { scopeType: 'CLASSIC_LEAGUE', scopeId: tournament.leagueId },
          {
            maxFetches: selectedFallbackTargets.length,
            requestDeadlineMs: workerRequestDeadlineMs,
          },
        );
        refreshErrorCode = refreshErrorCode ?? summaryRefresh.errorCode;
      }
    } else {
      const selectedSummaryTargets = takeWorkerSummaryTargets(staleOrMissingForWorker);
      if (selectedSummaryTargets.length > 0) {
        const summaryRefresh = await refreshEntrySummaries(
          season,
          input.eventId,
          selectedSummaryTargets,
          rows,
          redis,
          input.tournamentId !== undefined && tournament?.leagueType === 'h2h'
            ? entryScope
            : entryScope,
          {
            maxFetches: selectedSummaryTargets.length,
            requestDeadlineMs: workerRequestDeadlineMs,
          },
        );
        refreshErrorCode = summaryRefresh.errorCode;
      }
    }

    const metadataRows = uniqueEntryIds
      .map((entryId) => rows.get(entryId))
      .filter((row): row is CachedRow => row !== undefined && isWithinStaleWindow(row));
    for (const row of metadataRows) {
      if (initialRevisionByEntry.get(row.entryId) !== `${row.revision}:${row.checkedAt}`) {
        sourceByEntry.set(row.entryId, 'UPSTREAM');
      }
    }
    let durableCoverageRows: CachedRow[] = [];
    let durableCoverageReadFailed = false;
    if (input.tournamentId !== undefined) {
      try {
        const checkpoints = await managerScoreCheckpointRepository.findByScopeAndEntryIds(
          season,
          input.eventId,
          scope,
          uniqueEntryIds,
        );
        durableCoverageRows = checkpoints.map((checkpoint) =>
          fromManagerScoreCheckpoint(checkpoint, season.seasonCode),
        );
      } catch (error) {
        durableCoverageReadFailed = true;
        logWarn('Manager live coverage checkpoint read failed', {
          eventId: input.eventId,
          tournamentId: input.tournamentId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    const nextRefreshAt = new Date(
      dependencies.clock.now().getTime() +
        (classicStandingsNextPage === null || classicStandingsNextPage === undefined
          ? REFRESH_SECONDS
          : INCOMPLETE_CLASSIC_REFRESH_SECONDS) *
          1000,
    ).toISOString();
    const projectionEntryIds = workerProjectionEntryIds(uniqueEntryIds, workerTournamentRefresh);
    const projectionEntryIdSet = new Set(projectionEntryIds);
    const result = await buildActiveManagerLiveResult({
      season,
      eventId: input.eventId,
      entryIds: projectionEntryIds,
      metadataRows: metadataRows.filter((row) => projectionEntryIdSet.has(row.entryId)),
      errorCode: refreshErrorCode,
      nextRefreshAt,
      sourceByEntry,
      classicStandingsNextPage,
      includeEffectiveLineup: input.includeEffectiveLineup,
      liveRef: input.liveRef,
      requestedCalculationMode: input.requestedCalculationMode,
    });
    if (input.tournamentId !== undefined && durableCoverageReadFailed) {
      // Keep the last authoritative coverage object in the response and do
      // not turn an unavailable checkpoint read into a zero-row publication.
      result.tournamentCoverage = tournamentCoverage;
    } else if (input.tournamentId !== undefined) {
      const durableCoverageEntryIds = new Set(
        durableCoverageRows
          .filter((row) => typeof row.eventPoints === 'number')
          .map((row) => row.entryId),
      );
      const durableMissingEntryIds = uniqueEntryIds.filter(
        (entryId) => !durableCoverageEntryIds.has(entryId),
      );
      const fullManagerRevision = managerRevision(
        season.seasonCode,
        input.eventId,
        durableCoverageRows,
        durableMissingEntryIds,
      );
      result.managerRevision = fullManagerRevision;
      const persistedCoverage = await persistTournamentCoverage({
        season,
        eventId: input.eventId,
        tournamentId: input.tournamentId,
        rosterRevision: tournamentRosterRevision(uniqueEntryIds),
        expectedEntries: uniqueEntryIds.length,
        rows: durableCoverageRows,
        errorCode: refreshErrorCode,
        managerRevision: fullManagerRevision,
        crawlComplete:
          tournament?.leagueType === 'classic'
            ? classicStandingsNextPage === null
            : refreshErrorCode === null,
      });
      result.tournamentCoverage = persistedCoverage ?? tournamentCoverage;
    }
    return result;
  }

  const classicTournament =
    input.tournamentId !== undefined && tournament?.leagueType === 'classic';
  const refreshNow = dependencies.clock.now().getTime();
  const usableCachedEntryIds = new Set(
    uniqueEntryIds.filter((entryId) => {
      const row = rows.get(entryId);
      return row !== undefined && isWithinStaleWindow(row, refreshNow);
    }),
  );
  const refreshPlan = planManagerLiveRefreshTargets(
    uniqueEntryIds,
    usableCachedEntryIds,
    new Set(
      uniqueEntryIds.filter((entryId) => {
        const row = rows.get(entryId);
        return row !== undefined && isFresh(row, refreshNow);
      }),
    ),
    { foregroundStale: classicTournament },
  );
  const staleOrMissing = refreshPlan.backgroundEntryIds;
  const foregroundRefreshTargets = refreshPlan.foregroundEntryIds;
  const coldEntryIds = new Set(
    uniqueEntryIds.filter((entryId) => !usableCachedEntryIds.has(entryId)),
  );
  const foregroundRefreshEntryIds = new Set(foregroundRefreshTargets);
  const staleLastGoodCount = staleOrMissing.filter(
    (entryId) => usableCachedEntryIds.has(entryId) && !foregroundRefreshEntryIds.has(entryId),
  ).length;
  if (staleLastGoodCount > 0) {
    logDebug('Serving last-good manager rows while refreshing in background', {
      eventId: input.eventId,
      scope: scopeKey(scope),
      staleRowCount: staleLastGoodCount,
    });
  }
  const classicOverallRankMissing =
    input.tournamentId !== undefined &&
    tournament?.leagueType === 'classic' &&
    uniqueEntryIds.some((entryId) => shouldRefreshClassicOverallRank(rows.get(entryId), false));
  let errorCode: ManagerLiveResolveResult['errorCode'] = null;
  let refreshErrorCode: Exclude<
    ManagerLiveResolveResult['errorCode'],
    'UNSUPPORTED_H2H_LIVE' | null
  > | null = null;
  let refreshQueued = false;

  if (input.tournamentId !== undefined && tournament?.leagueType === 'h2h') {
    // FPL does not expose a live H2H table, but its official entry summary is
    // still a well-defined event score. Use it for provisional pairings and
    // let the final database result replace it after finalization.
    if (foregroundRefreshTargets.length > 0) {
      const summaryRefresh = await refreshEntrySummaries(
        season,
        input.eventId,
        foregroundRefreshTargets,
        rows,
        redis,
        entryScope,
        { maxFetches: MAX_FOREGROUND_SUMMARY_FETCHES },
      );
      refreshErrorCode = summaryRefresh.errorCode;
    }
    const pending = staleOrMissing.filter(
      (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
    );
    // A completely cold request has no response-local last-good state to
    // protect. Do not leave an unbounded in-process retry behind the request;
    // cache-only callers enqueue the durable worker, while a later
    // read-through request can retry synchronously. Local background work is
    // reserved for scopes that already have at least one retained row.
    if (pending.length > 0 && rows.size > 0) {
      const backgroundKey = `h2h:${season.seasonCode}:${input.eventId}:${input.tournamentId}:${pending
        .slice()
        .sort((left, right) => left - right)
        .join(',')}`;
      const backgroundWorkKey = `${backgroundKey}:entries:${pending
        .slice()
        .sort((left, right) => left - right)
        .join(',')}`;
      const capturedBackgroundRows = new Map(rows);
      scheduleBackgroundRefresh(backgroundKey, backgroundWorkKey, async () => {
        const backgroundRows = await readBackgroundRows(
          redis,
          season,
          input.eventId,
          entryScope,
          pending,
          capturedBackgroundRows,
        );
        await refreshEntrySummaries(
          season,
          input.eventId,
          pending,
          backgroundRows,
          redis,
          entryScope,
          { priority: 'background' },
        );
        logDebug('Official H2H manager background refresh completed', {
          eventId: input.eventId,
          tournamentId: input.tournamentId,
          remaining: pending.length,
        });
      });
    }
  } else if (
    input.tournamentId !== undefined &&
    (staleOrMissing.length > 0 || classicOverallRankMissing)
  ) {
    if (!tournament) throw new Error('Tournament validation unexpectedly missing');
    const classicLeagueId = tournament.leagueId;
    const classicRefreshKey = `${season.seasonCode}:${input.eventId}:${classicLeagueId}`;
    let standings: Awaited<ReturnType<typeof refreshClassicStandings>> = {
      complete: false,
      nextPage: 1,
      errorCode: null,
      refreshedEntryIds: [],
    };
    let foregroundRankEnrichedEntryIds: readonly number[] = [];
    const foregroundRankMissingEntryIds = selectForegroundClassicRankEntryIds(
      uniqueEntryIds,
      rows,
      isFresh,
      classicStandingNeedsOverallRank,
      MAX_FOREGROUND_OVERALL_RANK_FETCHES,
    );
    const foregroundLaneEntryIds = Array.from(
      new Set([...foregroundRefreshTargets, ...foregroundRankMissingEntryIds]),
    );
    if (foregroundLaneEntryIds.length > 0) {
      let foregroundRefresh: {
        standings: Awaited<ReturnType<typeof refreshClassicStandings>>;
        rankError: EntrySummaryRefreshResult | null;
      } = {
        standings,
        rankError: null,
      };
      try {
        foregroundRefresh = await runClassicStandingsRefresh(
          redis,
          classicRefreshKey,
          async (assertLeaseOwned) => {
            const latestRows = await readBackgroundRows(
              redis,
              season,
              input.eventId,
              scope,
              foregroundLaneEntryIds,
              rows,
            );
            mergeLatestRows(rows, latestRows);
            const standingsTargets = pendingManagerRefreshEntryIds(
              foregroundRefreshTargets,
              rows,
              isFresh,
            );
            const nextStandings =
              standingsTargets.length > 0
                ? await refreshClassicStandings(
                    season,
                    input.eventId,
                    classicLeagueId,
                    new Set(standingsTargets),
                    rows,
                    redis,
                    { priority: 'live' },
                    assertLeaseOwned,
                  )
                : {
                    complete: true,
                    nextPage: 1,
                    errorCode: null,
                    refreshedEntryIds: [],
                  };
            // The lane remains held through OR enrichment so an older standings
            // snapshot cannot be re-published after a newer same-league crawl.
            const rankCandidateIds = new Set([
              ...foregroundRankMissingEntryIds,
              ...(nextStandings.refreshedEntryIds ?? []),
            ]);
            const refreshedRankCandidateIds = new Set(nextStandings.refreshedEntryIds ?? []);
            const rankOnlyCandidateIds = new Set(foregroundRankMissingEntryIds);
            const rankTargets = uniqueEntryIds
              .filter((entryId) => {
                const row = rows.get(entryId);
                return (
                  rankCandidateIds.has(entryId) &&
                  row?.source === 'FPL_CLASSIC_STANDINGS' &&
                  shouldEnrichClassicOverallRank(
                    entryId,
                    row,
                    refreshedRankCandidateIds,
                    rankOnlyCandidateIds,
                    isFresh,
                    classicStandingNeedsOverallRank,
                  )
                );
              })
              .slice(0, MAX_FOREGROUND_OVERALL_RANK_FETCHES);
            const rankError =
              rankTargets.length > 0
                ? await refreshEntrySummaries(
                    season,
                    input.eventId,
                    rankTargets,
                    rows,
                    redis,
                    scope,
                    {
                      force: true,
                      preserveClassicStanding: true,
                      assertLeaseOwned,
                    },
                  )
                : null;
            // A partial wave does not identify which entry failed. Conservatively
            // retry the whole refreshed set in the background; the shared result
            // cache makes successful duplicates cheap and preserves one official
            // observation across replicas.
            foregroundRankEnrichedEntryIds = rankError === null ? rankTargets : [];
            return { standings: nextStandings, rankError };
          },
          'foreground',
        );
      } catch (error) {
        if (!(error instanceof ManagerLiveLeaseOwnershipError)) throw error;
        refreshErrorCode = 'UPSTREAM_UNAVAILABLE';
        logWarn('Official classic manager foreground lease lost; preserving last-good rows', {
          eventId: input.eventId,
          leagueId: classicLeagueId,
        });
      }
      standings = foregroundRefresh.standings;
      refreshErrorCode =
        refreshErrorCode ?? standings.errorCode ?? foregroundRefresh.rankError?.errorCode ?? null;
    } else {
      refreshErrorCode = standings.errorCode;
    }

    let pendingCold = foregroundRefreshTargets.filter(
      (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
    );
    const foregroundFallbackPlan = planClassicManagerFallback(pendingCold, [], standings.complete);
    if (foregroundFallbackPlan.foregroundSummaryEntryIds.length > 0) {
      let summaryError: EntrySummaryRefreshResult | null = null;
      try {
        summaryError = await runClassicStandingsRefresh(
          redis,
          classicRefreshKey,
          async (assertLeaseOwned) => {
            const latestRows = await readBackgroundRows(
              redis,
              season,
              input.eventId,
              scope,
              foregroundFallbackPlan.foregroundSummaryEntryIds,
              rows,
            );
            mergeLatestRows(rows, latestRows);
            const summaryTargets = foregroundFallbackPlan.foregroundSummaryEntryIds.filter(
              (entryId) => {
                const row = rows.get(entryId);
                return classicManagerSummaryFallbackNeedsRefresh(row, row ? isFresh(row) : false);
              },
            );
            return summaryTargets.length > 0
              ? refreshEntrySummaries(season, input.eventId, summaryTargets, rows, redis, scope, {
                  assertLeaseOwned,
                })
              : null;
          },
          'foreground',
        );
      } catch (error) {
        if (!(error instanceof ManagerLiveLeaseOwnershipError)) throw error;
        refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
        logWarn('Official classic manager fallback lease lost; preserving last-good rows', {
          eventId: input.eventId,
          leagueId: classicLeagueId,
        });
      }
      refreshErrorCode = refreshErrorCode ?? summaryError?.errorCode ?? null;
      pendingCold = foregroundRefreshTargets.filter(
        (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
      );
    }

    const pendingStale = staleOrMissing.filter(
      (entryId) =>
        !coldEntryIds.has(entryId) &&
        usableCachedEntryIds.has(entryId) &&
        (!rows.has(entryId) || !isFresh(rows.get(entryId)!)),
    );
    const staleSummaryFallbackIds = new Set(
      pendingStale.filter((entryId) => rows.get(entryId)?.source === 'FPL_ENTRY_SUMMARY'),
    );
    const backgroundPlan = planClassicManagerFallback(
      pendingCold,
      pendingStale,
      standings.complete,
    );
    const foregroundRankEnrichedIds = new Set(foregroundRankEnrichedEntryIds);
    const deferredForegroundRankTargets = (standings.refreshedEntryIds ?? []).filter(
      (entryId) => !foregroundRankEnrichedIds.has(entryId),
    );
    const pendingRefreshIds = new Set([...pendingCold, ...pendingStale]);
    const rankOnlyTargets = Array.from(
      new Set([
        ...deferredForegroundRankTargets,
        ...uniqueEntryIds.filter(
          (entryId) =>
            !pendingRefreshIds.has(entryId) && classicStandingNeedsOverallRank(rows.get(entryId)),
        ),
      ]),
    );
    const backgroundEntryIds = Array.from(
      new Set([
        ...backgroundPlan.backgroundStandingsEntryIds,
        ...backgroundPlan.backgroundSummaryEntryIds,
        ...rankOnlyTargets,
      ]),
    );
    const backgroundStandingsStartPage = classicManagerBackgroundStandingsStartPage(
      backgroundPlan.backgroundStandingsEntryIds,
      coldEntryIds,
      standings.nextPage,
    );
    if (backgroundEntryIds.length > 0 && rows.size > 0) {
      const backgroundKey = managerLiveBackgroundRefreshKey(
        `classic:${season.seasonCode}:${input.eventId}:${classicLeagueId}`,
        backgroundEntryIds,
      );
      const backgroundWorkKey = `${backgroundKey}:standings:${backgroundPlan.backgroundStandingsEntryIds
        .slice()
        .sort((left, right) => left - right)
        .join(',')}:summary:${backgroundPlan.backgroundSummaryEntryIds
        .slice()
        .sort((left, right) => left - right)
        .join(',')}:rank:${rankOnlyTargets
        .slice()
        .sort((left, right) => left - right)
        .join(',')}`;
      const capturedBackgroundRows = new Map(rows);
      const scheduleClassicBackgroundRefresh = (startPage: number): void => {
        scheduleBackgroundRefresh(
          backgroundKey,
          `${backgroundWorkKey}:standings-page:${startPage}`,
          async () => {
            let backgroundRows = new Map(capturedBackgroundRows);
            let backgroundResult: Awaited<ReturnType<typeof refreshClassicStandings>> = {
              complete: standings.complete,
              nextPage: standings.nextPage,
              errorCode: null,
              refreshedEntryIds: [],
            };
            if (backgroundPlan.backgroundStandingsEntryIds.length > 0) {
              const backgroundMaxPage = Math.min(
                MAX_STANDINGS_PAGES,
                startPage + MAX_BACKGROUND_STANDINGS_PAGES - 1,
              );
              backgroundResult = await runManagerStandingsPageSequence(
                startPage,
                backgroundMaxPage,
                async (page) => {
                  const pageResult = await runClassicStandingsRefresh(
                    redis,
                    classicRefreshKey,
                    async (assertLeaseOwned) => {
                      // Re-read after entering every page-sized lane. Foreground
                      // work can jump ahead between pages, and this crawl observes
                      // any publication that completed while it yielded.
                      backgroundRows = await readBackgroundRows(
                        redis,
                        season,
                        input.eventId,
                        scope,
                        backgroundEntryIds,
                        capturedBackgroundRows,
                      );
                      const standingsTargets = pendingManagerRefreshEntryIds(
                        backgroundPlan.backgroundStandingsEntryIds,
                        backgroundRows,
                        isFresh,
                      );
                      return standingsTargets.length > 0
                        ? refreshClassicStandings(
                            season,
                            input.eventId,
                            classicLeagueId,
                            new Set(standingsTargets),
                            backgroundRows,
                            redis,
                            { startPage: page, maxPages: 1 },
                            assertLeaseOwned,
                          )
                        : {
                            complete: true,
                            nextPage: page,
                            errorCode: null,
                            refreshedEntryIds: [],
                          };
                    },
                    'background',
                  );
                  return { ...pageResult, refreshedEntryIds: pageResult.refreshedEntryIds ?? [] };
                },
              );
              const continuationPage = nextManagerLiveStandingsContinuation(
                backgroundResult,
                MAX_STANDINGS_PAGES,
              );
              if (continuationPage !== null) {
                scheduleClassicBackgroundRefresh(continuationPage);
              }
            }

            // Only rows refreshed by a successful page (plus rows that were
            // already fresh rank-only targets) may receive OR enrichment. A failed
            // crawl must not stamp an old standings row fresh through summary data.
            const refreshedStandingsIds = new Set([
              ...deferredForegroundRankTargets,
              ...(backgroundResult.refreshedEntryIds ?? []),
            ]);
            const rankOnlyEntryIds = new Set(
              rankOnlyTargets.filter((entryId) => !refreshedStandingsIds.has(entryId)),
            );
            const backgroundRankTargets = Array.from(
              new Set([...rankOnlyTargets, ...(backgroundResult.refreshedEntryIds ?? [])]),
            ).filter((entryId) => {
              const row = backgroundRows.get(entryId);
              return (
                row?.source === 'FPL_CLASSIC_STANDINGS' &&
                shouldEnrichClassicOverallRank(
                  entryId,
                  row,
                  refreshedStandingsIds,
                  rankOnlyEntryIds,
                  isFresh,
                  classicStandingNeedsOverallRank,
                )
              );
            });

            // Hold the league lane for one four-entry upstream wave at a time.
            // Foreground misses can therefore jump ahead between background waves,
            // while every merge still observes the latest serialized standings row.
            for (const batch of managerSummaryFetchBatches(backgroundRankTargets)) {
              await runClassicStandingsRefresh(
                redis,
                classicRefreshKey,
                async (assertLeaseOwned) => {
                  const batchRows = await readBackgroundRows(
                    redis,
                    season,
                    input.eventId,
                    scope,
                    batch,
                    backgroundRows,
                  );
                  const rankTargets = batch.filter((entryId) => {
                    const row = batchRows.get(entryId);
                    return (
                      row?.source === 'FPL_CLASSIC_STANDINGS' &&
                      shouldEnrichClassicOverallRank(
                        entryId,
                        row,
                        refreshedStandingsIds,
                        rankOnlyEntryIds,
                        isFresh,
                        classicStandingNeedsOverallRank,
                      )
                    );
                  });
                  if (rankTargets.length > 0) {
                    await refreshEntrySummaries(
                      season,
                      input.eventId,
                      rankTargets,
                      batchRows,
                      redis,
                      scope,
                      {
                        force: true,
                        priority: 'background',
                        preserveClassicStanding: true,
                        assertLeaseOwned,
                      },
                    );
                  }
                  mergeLatestRows(backgroundRows, batchRows);
                },
                'background',
              );
            }

            const summaryCandidates = classicManagerSummaryFallbackEntryIds(
              backgroundPlan.backgroundSummaryEntryIds,
              backgroundPlan.backgroundStandingsEntryIds,
              coldEntryIds,
              staleSummaryFallbackIds,
              backgroundResult.complete,
            );
            for (const batch of managerSummaryFetchBatches(summaryCandidates)) {
              await runClassicStandingsRefresh(
                redis,
                classicRefreshKey,
                async (assertLeaseOwned) => {
                  const batchRows = await readBackgroundRows(
                    redis,
                    season,
                    input.eventId,
                    scope,
                    batch,
                    backgroundRows,
                  );
                  const summaryTargets = batch.filter((entryId) => {
                    const row = batchRows.get(entryId);
                    // Summary is a new-entry fallback only. A classic row that
                    // appeared while this job waited owns phase totals and rank.
                    return classicManagerSummaryFallbackNeedsRefresh(
                      row,
                      row ? isFresh(row) : false,
                    );
                  });
                  if (summaryTargets.length > 0) {
                    await refreshEntrySummaries(
                      season,
                      input.eventId,
                      summaryTargets,
                      batchRows,
                      redis,
                      scope,
                      { priority: 'background', assertLeaseOwned },
                    );
                  }
                  mergeLatestRows(backgroundRows, batchRows);
                },
                'background',
              );
            }
            logDebug('Official classic manager background refresh completed', {
              eventId: input.eventId,
              leagueId: classicLeagueId,
              remaining: summaryCandidates.length,
              complete: backgroundResult.complete,
            });
          },
        );
      };
      scheduleClassicBackgroundRefresh(backgroundStandingsStartPage);
    }
  }

  if (input.tournamentId === undefined && staleOrMissing.length > 0) {
    if (foregroundRefreshTargets.length > 0) {
      const summaryRefresh = await refreshEntrySummaries(
        season,
        input.eventId,
        foregroundRefreshTargets,
        rows,
        redis,
        entryScope,
        {
          maxFetches: MAX_FOREGROUND_SUMMARY_FETCHES,
        },
      );
      refreshErrorCode = summaryRefresh.errorCode;
    }
    const pending = staleOrMissing.filter(
      (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
    );
    if (pending.length > 0 && rows.size > 0) {
      const backgroundKey = managerLiveBackgroundRefreshKey(
        `summary:${season.seasonCode}:${input.eventId}`,
        pending,
      );
      const backgroundWorkKey = `${backgroundKey}:entries:${pending
        .slice()
        .sort((left, right) => left - right)
        .join(',')}`;
      const capturedBackgroundRows = new Map(rows);
      scheduleBackgroundRefresh(backgroundKey, backgroundWorkKey, async () => {
        const backgroundRows = await readBackgroundRows(
          redis,
          season,
          input.eventId,
          entryScope,
          pending,
          capturedBackgroundRows,
        );
        await refreshEntrySummaries(
          season,
          input.eventId,
          pending,
          backgroundRows,
          redis,
          entryScope,
          { priority: 'background' },
        );
      });
    }
  }

  if (classicTournament) {
    // A Classic standings row carries the tournament league rank, while the
    // entry summary is the shared official headline used by the detail page.
    // Reuse that entry-scope observation when it is at least as new as the
    // standings observation so both pages converge on one event score.
    const entrySummaryRows = await readCachedAndCheckpointRows(
      redis,
      season,
      input.eventId,
      entryScope,
      uniqueEntryIds,
    );
    for (const entryId of uniqueEntryIds) {
      const merged = mergeClassicStandingWithEntrySummary(
        rows.get(entryId),
        entrySummaryRows.get(entryId),
      );
      if (merged) rows.set(entryId, merged);
    }

    // Keep this convergence wave bounded. Subsequent board polls advance to
    // the next stale entries instead of creating a 98-request FPL burst.
    // Rotate the bounded window by refresh cycle. A permanently unavailable
    // first cohort must not prevent later managers from converging.
    const summaryRefreshWave = Math.floor(refreshNow / (REFRESH_SECONDS * 1000));
    const summaryRefreshOffset =
      uniqueEntryIds.length === 0 ? 0 : summaryRefreshWave % uniqueEntryIds.length;
    const summaryRefreshEntryIds = rotateManagerLiveEntryIds(
      uniqueEntryIds,
      summaryRefreshOffset,
      uniqueEntryIds.length,
    )
      .filter((entryId) => {
        const summary = entrySummaryRows.get(entryId);
        return summary === undefined || !isFresh(summary);
      })
      .slice(0, MAX_FOREGROUND_SUMMARY_FETCHES);
    if (summaryRefreshEntryIds.length > 0) {
      const backgroundKey = managerLiveBackgroundRefreshKey(
        `summary:${season.seasonCode}:${input.eventId}`,
        summaryRefreshEntryIds,
      );
      const backgroundWorkKey = `${backgroundKey}:classic-headline`;
      const capturedSummaryRows = new Map(entrySummaryRows);
      scheduleBackgroundRefresh(backgroundKey, backgroundWorkKey, async () => {
        const backgroundRows = await readBackgroundRows(
          redis,
          season,
          input.eventId,
          entryScope,
          summaryRefreshEntryIds,
          capturedSummaryRows,
        );
        const targets = summaryRefreshEntryIds.filter((entryId) => {
          const row = backgroundRows.get(entryId);
          return row === undefined || !isFresh(row);
        });
        if (targets.length > 0) {
          await refreshEntrySummaries(
            season,
            input.eventId,
            targets,
            backgroundRows,
            redis,
            entryScope,
            { priority: 'background' },
          );
        }
      });
    }
  }

  // READ_THROUGH may serve a bounded page from cache/checkpoints while its
  // local background crawl is still running. Queue the durable tournament
  // worker as the coverage owner so a page request cannot leave the full-field
  // coverage row null or stale forever. Dispatch is bounded and deduplicated
  // by the tournament hot scope; it does not add an upstream wait to this
  // response.
  if (input.tournamentId !== undefined && currentTournamentRosterRevision !== null) {
    try {
      refreshQueued =
        (await dispatchManagerLiveRefreshBounded({
          season,
          eventId: input.eventId,
          entryIds: coverageRosterEntryIds,
          tournamentId: input.tournamentId,
          rosterRevision: currentTournamentHotRosterRevision,
        })) === 'QUEUED';
    } catch (error) {
      logWarn('Manager live read-through coverage dispatch failed', {
        eventId: input.eventId,
        tournamentId: input.tournamentId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  const now = dependencies.clock.now().getTime();
  const metadataRows = uniqueEntryIds
    .map((entryId) => rows.get(entryId))
    .filter((row): row is CachedRow => row !== undefined && isWithinStaleWindow(row, now));
  for (const row of metadataRows) {
    if (initialRevisionByEntry.get(row.entryId) !== `${row.revision}:${row.checkedAt}`) {
      sourceByEntry.set(row.entryId, 'UPSTREAM');
    }
  }
  if (!errorCode && refreshErrorCode) errorCode = refreshErrorCode;

  return buildActiveManagerLiveResult({
    season,
    eventId: input.eventId,
    entryIds: uniqueEntryIds,
    metadataRows,
    errorCode,
    checkedAt: nowIso(),
    nextRefreshAt: nextRefresh(event.finished),
    sourceByEntry,
    refreshQueued,
    ...(input.tournamentId === undefined ? {} : { tournamentCoverage }),
    includeEffectiveLineup: input.includeEffectiveLineup,
    liveRef: input.liveRef,
    requestedCalculationMode: input.requestedCalculationMode,
  });
};

export type ManagerLiveResolveRequest = {
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
  readMode?: ManagerLiveReadMode;
  includeEffectiveLineup?: boolean;
  liveRef?: { publicationId: string; revision: number | string };
  requestedCalculationMode?: Exclude<ManagerLiveCalculationMode, 'FINAL_RESULT'>;
};

export type ManagerLiveRefreshRequest = {
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
  classicStandingsStartPage?: number;
  summaryRotationCursor?: number;
};

export type ManagerLiveOrchestration = {
  resolve(input: ManagerLiveResolveRequest): Promise<ManagerLiveResolveResult>;
  refresh(input: ManagerLiveRefreshRequest): Promise<ManagerLiveResolveResult>;
};

/**
 * Bind the orchestration to explicit infrastructure ports. Each runtime owns
 * its own single-flight map, while unit tests can use fakes without importing
 * Redis, PostgreSQL, queue or provider adapters.
 */
export const createManagerLiveOrchestration = (
  dependencies: ManagerLiveOrchestrationDependencies,
): ManagerLiveOrchestration => {
  const inFlight = new Map<string, Promise<ManagerLiveResolveResult>>();

  const runSingleFlight = (
    key: string,
    input: Parameters<typeof resolveManagerLiveScoresUncoalesced>[0],
  ): Promise<ManagerLiveResolveResult> => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = resolveManagerLiveScoresUncoalesced(input, dependencies).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };

  return {
    resolve: (input) =>
      runSingleFlight(
        JSON.stringify({
          eventId: input.eventId,
          entryIds: Array.from(new Set(input.entryIds)).sort((a, b) => a - b),
          tournamentId: input.tournamentId ?? null,
          readMode: input.readMode ?? 'READ_THROUGH',
          includeEffectiveLineup: input.includeEffectiveLineup ?? false,
          liveRef: input.liveRef ?? null,
          requestedCalculationMode: input.requestedCalculationMode ?? 'PROJECTED_AUTOSUBS',
        }),
        input,
      ),
    refresh: (input) =>
      runSingleFlight(
        JSON.stringify({
          eventId: input.eventId,
          entryIds: Array.from(new Set(input.entryIds)).sort((left, right) => left - right),
          tournamentId: input.tournamentId ?? null,
          classicStandingsStartPage: input.classicStandingsStartPage ?? null,
          summaryRotationCursor: input.summaryRotationCursor ?? null,
          readMode: 'READ_THROUGH',
          completeRefresh: true,
        }),
        { ...input, readMode: 'READ_THROUGH', completeRefresh: true },
      ),
  };
};
