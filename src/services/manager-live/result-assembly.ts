// Manager Live assembly implementation. Kept behind the compatibility facade.
import { createHash } from 'node:crypto';
import { managerLiveTournamentCoverageRepository } from '../../repositories/live-window';
import { contentHash } from '../../utils/content-hash';
import { logWarn } from '../../utils/logger';
import type { FplSeasonRef } from '../../domain/fpl-season';
import { isFinalManagerLiveRevision } from '../../domain/manager-live-coverage';
import {
  EVENT_LIVE_PROJECTION_ALGORITHM_VERSION,
  isEffectiveLineup,
} from '../../domain/event-live-manager-projection';
import { eventLiveManagerScoreService } from '../event-live-manager-scores.service';
import { type ManagerScoreMaterializedRow } from '../../repositories/manager-score-materializations';
import type {
  ManagerLiveCalculationMode,
  ManagerLiveDataAvailability,
  ManagerLiveResolveResult,
  ManagerLiveScoreRow,
  ManagerLiveServedFrom,
  ManagerLiveTournamentCoverage,
} from './contracts';
import {
  deriveManagerLiveTournamentCoverageState,
  shouldPreserveManagerLiveTournamentCoverage,
} from './coverage';
import { projectEventLiveManagerRows } from './final-projection';
import {
  CachedRow,
  ManagerLiveRowBacking,
  REFRESH_SECONDS,
  STALE_SECONDS,
  nowIso,
  plusSeconds,
} from './publication-store';

export const ageSeconds = (checkedAt: string, now = Date.now()): number => {
  const timestamp = Date.parse(checkedAt);
  return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 1000) : Infinity;
};

export const isFresh = (row: CachedRow, now = Date.now()): boolean =>
  ageSeconds(row.checkedAt, now) <= REFRESH_SECONDS;

export const isWithinStaleWindow = (row: CachedRow, now = Date.now()): boolean =>
  // Redis expiry is an operational cleanup mechanism. A successful official
  // row remains the last-good value until a newer official or final result
  // replaces it; it must not disappear merely because 90 seconds elapsed.
  Number.isFinite(Date.parse(row.checkedAt)) && ageSeconds(row.checkedAt, now) >= 0;

export const managerRevision = (
  season: string,
  eventId: number,
  rows: readonly ManagerLiveScoreRow[],
  missingEntryIds: readonly number[],
): string =>
  createHash('sha1')
    .update(
      JSON.stringify({
        season,
        eventId,
        rows: rows
          .map((row) => [row.entryId, row.revision] as const)
          .sort((left, right) => left[0] - right[0]),
        missingEntryIds: [...missingEntryIds].sort((left, right) => left - right),
      }),
    )
    .digest('hex')
    .slice(0, 20);

export const managerCheckedAt = (
  rows: readonly ManagerLiveScoreRow[],
  fallback: string,
): string => {
  const timestamps = rows
    .map((row) => Date.parse(row.checkedAt))
    .filter((timestamp) => Number.isFinite(timestamp));
  return timestamps.length === 0 ? fallback : new Date(Math.min(...timestamps)).toISOString();
};

export const managerDataAvailability = (
  rows: readonly ManagerLiveScoreRow[],
  missingEntryIds: readonly number[],
  now = Date.now(),
): ManagerLiveDataAvailability => {
  if (rows.length === 0) return 'UNAVAILABLE';
  if (missingEntryIds.length > 0) return 'PARTIAL';
  return rows.every((row) => isFresh(row, now)) ? 'FRESH' : 'LAST_GOOD';
};

export const mapTournamentCoverage = (row: {
  rosterRevision: string;
  expectedEntries: number;
  resolvedEntries: number;
  fullyFetchedAt: Date | null;
  managerRevision: string | null;
  error: string | null;
  state: string;
}): ManagerLiveTournamentCoverage | null => {
  if (
    row.state !== 'WARMING' &&
    row.state !== 'COMPLETE' &&
    row.state !== 'PARTIAL' &&
    row.state !== 'UNAVAILABLE'
  ) {
    return null;
  }
  return {
    rosterRevision: row.rosterRevision,
    expectedEntries: row.expectedEntries,
    resolvedEntries: row.resolvedEntries,
    fullyFetchedAt: row.fullyFetchedAt?.toISOString() ?? null,
    managerRevision: row.managerRevision,
    error: row.error,
    state: row.state,
  };
};

export const readTournamentCoverage = async (
  season: FplSeasonRef,
  eventId: number,
  tournamentId: number,
): Promise<ManagerLiveTournamentCoverage | null> => {
  try {
    const row = await managerLiveTournamentCoverageRepository.findByTournamentAndEvent(
      season,
      eventId,
      tournamentId,
    );
    return row ? mapTournamentCoverage(row) : null;
  } catch (error) {
    logWarn('Manager live tournament coverage read failed', {
      eventId,
      tournamentId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
};

export const persistTournamentCoverage = async (input: {
  season: FplSeasonRef;
  eventId: number;
  tournamentId: number;
  rosterRevision: string;
  expectedEntries: number;
  rows: readonly ManagerLiveScoreRow[];
  errorCode: ManagerLiveResolveResult['errorCode'];
  managerRevision: string;
  crawlComplete: boolean;
}): Promise<ManagerLiveTournamentCoverage | null> => {
  let existing: Awaited<
    ReturnType<typeof managerLiveTournamentCoverageRepository.findByTournamentAndEvent>
  >;
  try {
    existing = await managerLiveTournamentCoverageRepository.findByTournamentAndEvent(
      input.season,
      input.eventId,
      input.tournamentId,
    );
  } catch (error) {
    logWarn('Manager live tournament coverage baseline read failed', {
      eventId: input.eventId,
      tournamentId: input.tournamentId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    // A failed baseline read must never be interpreted as an empty crawl. The
    // repository write is fenced as well, but skipping here keeps a transient
    // read failure from publishing 0 resolved rows over durable progress.
    return null;
  }
  const resolvedEntryIds = new Set(
    input.rows.filter((row) => typeof row.eventPoints === 'number').map((row) => row.entryId),
  );
  const preserveExistingComplete =
    shouldPreserveManagerLiveTournamentCoverage(
      existing,
      input.rosterRevision,
      input.expectedEntries,
    ) && !isFinalManagerLiveRevision(input.managerRevision);
  const resolvedEntries = preserveExistingComplete
    ? (existing?.resolvedEntries ?? 0)
    : Math.min(input.expectedEntries, resolvedEntryIds.size);
  const state = preserveExistingComplete
    ? 'COMPLETE'
    : deriveManagerLiveTournamentCoverageState({
        expectedEntries: input.expectedEntries,
        resolvedEntries,
        errorCode: input.errorCode,
        crawlComplete: input.crawlComplete,
      });
  const complete = state === 'COMPLETE';
  const fullyFetchedAt = complete
    ? preserveExistingComplete
      ? (existing?.fullyFetchedAt ?? null)
      : new Date()
    : existing?.rosterRevision === input.rosterRevision
      ? existing.fullyFetchedAt
      : null;
  const coverage: ManagerLiveTournamentCoverage = {
    rosterRevision: input.rosterRevision,
    expectedEntries: input.expectedEntries,
    resolvedEntries,
    fullyFetchedAt: fullyFetchedAt?.toISOString() ?? null,
    managerRevision: input.managerRevision,
    error: input.errorCode,
    state,
  };
  try {
    const accepted = await managerLiveTournamentCoverageRepository.upsert({
      seasonId: input.season.seasonId,
      eventId: input.eventId,
      tournamentId: input.tournamentId,
      rosterRevision: coverage.rosterRevision,
      expectedEntries: coverage.expectedEntries,
      resolvedEntries: coverage.resolvedEntries,
      fullyFetchedAt,
      managerRevision: coverage.managerRevision,
      error: coverage.error,
      state: coverage.state,
    });
    if (!accepted) {
      logWarn('Manager live tournament coverage publication rejected by roster fence', {
        eventId: input.eventId,
        tournamentId: input.tournamentId,
        rosterRevision: input.rosterRevision,
      });
      return null;
    }
  } catch (error) {
    logWarn('Manager live tournament coverage publication failed', {
      eventId: input.eventId,
      tournamentId: input.tournamentId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
  return coverage;
};

export const managerServedFrom = (
  rows: readonly ManagerLiveScoreRow[],
  sourceByEntry: ReadonlyMap<number, ManagerLiveRowBacking>,
): ManagerLiveServedFrom => {
  const sources = new Set(
    rows
      .map((row) => sourceByEntry.get(row.entryId))
      .filter((source): source is ManagerLiveRowBacking => source !== undefined),
  );
  if (sources.size === 0) return 'NONE';
  if (sources.has('UPSTREAM')) return sources.size === 1 ? 'NONE' : 'MIXED';
  if (sources.size > 1) return 'MIXED';
  return sources.has('REDIS') ? 'REDIS' : 'POSTGRES';
};

export const buildManagerLiveResult = (input: {
  season: string;
  eventId: number;
  rows: CachedRow[];
  missingEntryIds: number[];
  errorCode: ManagerLiveResolveResult['errorCode'];
  nextRefreshAt: string;
  sourceByEntry: ReadonlyMap<number, ManagerLiveRowBacking>;
  refreshQueued?: boolean;
  checkedAt?: string;
  tournamentCoverage?: ManagerLiveTournamentCoverage | null;
  classicStandingsNextPage?: number | null;
  calculationMode: ManagerLiveCalculationMode;
}): ManagerLiveResolveResult => {
  const fallbackCheckedAt = input.checkedAt ?? nowIso();
  return {
    season: input.season,
    eventId: input.eventId,
    managerRevision: managerRevision(
      input.season,
      input.eventId,
      input.rows,
      input.missingEntryIds,
    ),
    dataAvailability: managerDataAvailability(input.rows, input.missingEntryIds),
    servedFrom: managerServedFrom(input.rows, input.sourceByEntry),
    refreshQueued: input.refreshQueued ?? false,
    rows: input.rows,
    missingEntryIds: input.missingEntryIds,
    partial: input.missingEntryIds.length > 0,
    errorCode: input.errorCode,
    checkedAt: managerCheckedAt(input.rows, fallbackCheckedAt),
    servedAt: fallbackCheckedAt,
    calculationMode: input.calculationMode,
    nextRefreshAt: input.nextRefreshAt,
    ...(input.tournamentCoverage === undefined
      ? {}
      : { tournamentCoverage: input.tournamentCoverage }),
    ...(input.classicStandingsNextPage === undefined
      ? {}
      : { classicStandingsNextPage: input.classicStandingsNextPage }),
  };
};

export type ManagerLiveAuthorityDependencies = Pick<typeof eventLiveManagerScoreService, 'load'>;

export const buildActiveManagerLiveResult = async (
  input: {
    season: FplSeasonRef;
    eventId: number;
    entryIds: readonly number[];
    metadataRows: CachedRow[];
    errorCode: ManagerLiveResolveResult['errorCode'];
    nextRefreshAt: string;
    sourceByEntry: ReadonlyMap<number, ManagerLiveRowBacking>;
    refreshQueued?: boolean;
    checkedAt?: string;
    tournamentCoverage?: ManagerLiveTournamentCoverage | null;
    classicStandingsNextPage?: number | null;
    liveRef?: { publicationId: string; revision: number | string };
    includeEffectiveLineup?: boolean;
    requestedCalculationMode?: Exclude<ManagerLiveCalculationMode, 'FINAL_RESULT'>;
  },
  dependencies: ManagerLiveAuthorityDependencies = eventLiveManagerScoreService,
): Promise<ManagerLiveResolveResult> => {
  const batch = await dependencies
    .load(input.season, input.eventId, input.entryIds, {
      liveRef: input.liveRef,
      includeEffectiveLineup: input.includeEffectiveLineup,
      requestedCalculationMode: input.requestedCalculationMode,
    })
    .catch((error) => {
      logWarn('Event-live manager score authority unavailable', {
        eventId: input.eventId,
        entries: input.entryIds.length,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    });
  const rows = projectEventLiveManagerRows(
    input.season.seasonCode,
    input.eventId,
    input.entryIds,
    input.metadataRows,
    batch,
  );
  const resolvedIds = new Set(rows.map((row) => row.entryId));
  const missingEntryIds = input.entryIds.filter((entryId) => !resolvedIds.has(entryId));
  const authorityErrorCode =
    batch === null && input.liveRef !== undefined
      ? ('REVISION_UNAVAILABLE' as const)
      : batch !== null && missingEntryIds.length > 0
        ? ('INPUT_INCOMPLETE' as const)
        : undefined;
  return buildManagerLiveResult({
    season: input.season.seasonCode,
    eventId: input.eventId,
    rows,
    missingEntryIds,
    errorCode:
      missingEntryIds.length > 0
        ? (authorityErrorCode ?? input.errorCode ?? 'UPSTREAM_UNAVAILABLE')
        : (authorityErrorCode ?? input.errorCode),
    nextRefreshAt: input.nextRefreshAt,
    // `servedFrom` remains the response/cache backing contract. Score
    // authority is carried independently by row.source/revision/checkedAt.
    sourceByEntry: input.sourceByEntry,
    checkedAt: batch?.checkedAt ?? input.checkedAt,
    ...(input.tournamentCoverage === undefined
      ? {}
      : { tournamentCoverage: input.tournamentCoverage }),
    calculationMode:
      batch?.calculationMode ?? input.requestedCalculationMode ?? 'PROJECTED_AUTOSUBS',
    ...(input.refreshQueued === undefined ? {} : { refreshQueued: input.refreshQueued }),
    ...(input.classicStandingsNextPage === undefined
      ? {}
      : { classicStandingsNextPage: input.classicStandingsNextPage }),
  });
};

export const materializedProjectedRows = (
  season: string,
  eventId: number,
  entryIds: readonly number[],
  materializations: readonly ManagerScoreMaterializedRow[],
  includeEffectiveLineup: boolean,
  expectedLiveRef?: { publicationId: string; revision: number | string },
  rankMetadataRows: readonly CachedRow[] = [],
): CachedRow[] => {
  const byEntry = new Map(materializations.map((row) => [row.entryId, row] as const));
  const rankMetadataByEntry = new Map(rankMetadataRows.map((row) => [row.entryId, row] as const));
  return entryIds.flatMap((entryId) => {
    const row = byEntry.get(entryId);
    if (
      !row ||
      row.scoreSource !== 'FPL_EVENT_LIVE' ||
      row.livePublicationId === null ||
      row.liveRevision === null ||
      row.liveCheckedAt === null ||
      row.verifiedLiveCheckedAt === null ||
      row.algorithmVersion === null ||
      row.picksRevision === null ||
      row.picksCheckedAt === null ||
      row.previousTotalsRevision === null ||
      row.eventPoints === null ||
      row.netEventPoints === null ||
      row.transferCost === null ||
      (expectedLiveRef !== undefined &&
        (row.livePublicationId !== expectedLiveRef.publicationId ||
          String(row.liveRevision) !== String(expectedLiveRef.revision))) ||
      row.algorithmVersion !== EVENT_LIVE_PROJECTION_ALGORITHM_VERSION ||
      !isEffectiveLineup(row.effectiveLineup) ||
      row.netEventPoints !== row.eventPoints - row.transferCost ||
      !Number.isFinite(row.liveCheckedAt.getTime()) ||
      !Number.isFinite(row.verifiedLiveCheckedAt.getTime()) ||
      !Number.isFinite(row.picksCheckedAt.getTime()) ||
      contentHash({
        inputRevision: row.inputRevision,
        eventPoints: row.eventPoints,
        netEventPoints: row.netEventPoints,
        totalPoints: row.totalPoints,
        effectiveLineup: row.effectiveLineup,
      }) !== row.scoreRevision
    ) {
      return [];
    }
    const rankMetadataCandidate = rankMetadataByEntry.get(entryId);
    const rankMetadata =
      rankMetadataCandidate &&
      (rankMetadataCandidate.source === 'FPL_ENTRY_SUMMARY' ||
        rankMetadataCandidate.source === 'FPL_CLASSIC_STANDINGS') &&
      Number.isFinite(Date.parse(rankMetadataCandidate.checkedAt)) &&
      isWithinStaleWindow(rankMetadataCandidate)
        ? rankMetadataCandidate
        : undefined;
    const rankRevision = rankMetadata
      ? contentHash({
          entryId,
          eventId,
          source: rankMetadata.source,
          eventRank: rankMetadata.eventRank,
          overallRank: rankMetadata.overallRank,
          leagueRank: rankMetadata.leagueRank,
        })
      : null;
    const checkedAt = row.verifiedLiveCheckedAt.toISOString();
    const effectiveLineup =
      includeEffectiveLineup && isEffectiveLineup(row.effectiveLineup)
        ? (row.effectiveLineup as CachedRow['effectiveLineup'])
        : undefined;
    return [
      {
        season,
        eventId,
        entryId,
        eventPoints: row.eventPoints,
        netEventPoints: row.netEventPoints,
        totalPoints: row.totalPoints,
        totalScope: 'OVERALL' as const,
        eventRank: rankMetadata?.eventRank ?? null,
        overallRank: rankMetadata?.overallRank ?? null,
        leagueRank: rankMetadata?.leagueRank ?? null,
        source: 'FPL_EVENT_LIVE' as const,
        transferCost: row.transferCost,
        eventPointSemantics:
          row.transferCost === 0 ? ('ZERO_COST_EQUIVALENT' as const) : ('GROSS' as const),
        revision: `${row.scoreRevision}:${rankRevision ?? 'none'}`,
        checkedAt,
        upstreamUpdatedAt: checkedAt,
        staleAt: plusSeconds(checkedAt, STALE_SECONDS),
        calculationMode: row.calculationMode,
        algorithmVersion: row.algorithmVersion,
        ...(effectiveLineup ? { effectiveLineup } : {}),
        provenance: {
          scoreSource: 'FPL_EVENT_LIVE' as const,
          calculationMode: row.calculationMode,
          algorithmVersion: row.algorithmVersion,
          inputRevision: row.inputRevision,
          scoreRevision: row.scoreRevision,
          rankRevision,
          livePublicationId: row.livePublicationId,
          liveRevision: row.liveRevision,
          liveCheckedAt: checkedAt,
          picksRevision: row.picksRevision,
          picksCheckedAt: row.picksCheckedAt?.toISOString() ?? null,
          previousTotalsRevision: row.previousTotalsRevision,
          previousTotalsThroughEventId: row.previousTotalsThroughEventId,
          resultRevision: null,
          resultCheckedAt: null,
          dataCheckedAt: null,
          rankSource:
            rankMetadata?.source === 'FPL_ENTRY_SUMMARY' ||
            rankMetadata?.source === 'FPL_CLASSIC_STANDINGS'
              ? rankMetadata.source
              : null,
          rankCheckedAt: rankMetadata?.checkedAt ?? null,
        },
      },
    ];
  });
};
