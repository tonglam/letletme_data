// Manager Live provider classic implementation.
import type Redis from 'ioredis';
import { fplClient } from '../../clients/fpl';
import { readDatabaseOrderingTimestamp } from '../../db/ordering-timestamp';
import { type ManagerScoreScope } from '../../repositories/live-window';
import { FPLClientError } from '../../utils/errors';
import { logDebug, logWarn } from '../../utils/logger';
import type { FplSeasonRef } from '../../domain/fpl-season';
import { MANAGER_LIVE_CLASSIC_CAPPED_CURSOR } from '../../domain/manager-live-refresh';
import {
  isPositiveOverallRank,
  mergeUniqueTargetManagerRows,
  preserveLastKnownOverallRank,
} from '../../domain/manager-live-fallback';
import type { ManagerLiveScoreRow } from './contracts';
import {
  CachedRow,
  ClassicStandingsRefreshDependencies,
  MAX_FOREGROUND_STANDINGS_PAGES,
  MAX_STANDINGS_PAGES,
  REFRESH_SECONDS,
  STALE_SECONDS,
  classicStandingNeedsOverallRank,
  mergeLatestManagerLiveRow,
  nowIso,
  plusSeconds,
  readCachedRowsForPublication,
  readClassicPublicationState,
  reconcileClassicRowsAfterCachePublication,
  toClassicRows,
  withOverallRank,
  withPreservedOverallRank,
  withRevision,
  writeCheckpointRows,
  writeClassicRowsMonotonically,
} from './publication-store';
import { managerLivePublicationKey, runManagerLivePublication } from './provider-coordination';

export const refreshClassicStandings = async (
  season: FplSeasonRef,
  eventId: number,
  leagueId: number,
  targetIds: ReadonlySet<number>,
  rows: Map<number, CachedRow>,
  redis: Redis | null,
  options: { startPage?: number; maxPages?: number; requestDeadlineMs?: number } = {},
  assertLeaseOwned: () => Promise<void> = async () => undefined,
  dependencies: Partial<ClassicStandingsRefreshDependencies> = {},
): Promise<{
  complete: boolean;
  nextPage: number;
  errorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null;
  refreshedEntryIds: readonly number[];
}> => {
  const fetchStandings =
    dependencies.fetchStandings ?? fplClient.getLeagueClassicStandings.bind(fplClient);
  const readCachedRows = dependencies.readCachedRowsForPublication ?? readCachedRowsForPublication;
  const readPublicationState = dependencies.readPublicationState ?? readClassicPublicationState;
  const runPublication = dependencies.runPublication ?? runManagerLivePublication;
  const readOrderingTimestamp = dependencies.readOrderingTimestamp ?? readDatabaseOrderingTimestamp;
  const writeCheckpoint = dependencies.writeCheckpointRows ?? writeCheckpointRows;
  const writeCache = dependencies.writeCache ?? writeClassicRowsMonotonically;
  const reconcileCache = dependencies.reconcileCache ?? reconcileClassicRowsAfterCachePublication;
  const crawlStartedAt = nowIso();
  let fetchedRows = new Map<number, ManagerLiveScoreRow>();
  const classicScope: ManagerScoreScope = { scopeType: 'CLASSIC_LEAGUE', scopeId: leagueId };
  const startPage = options.startPage ?? 1;
  const maxPages = options.maxPages ?? MAX_FOREGROUND_STANDINGS_PAGES;
  let nextPage = startPage;
  let exhausted = false;
  let refreshErrorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null = null;
  if (startPage > MAX_STANDINGS_PAGES) {
    return {
      complete: false,
      nextPage: MANAGER_LIVE_CLASSIC_CAPPED_CURSOR,
      errorCode: 'UPSTREAM_UNAVAILABLE',
      refreshedEntryIds: [],
    };
  }
  try {
    for (
      let page = startPage;
      page <= MAX_STANDINGS_PAGES &&
      page < startPage + maxPages &&
      fetchedRows.size < targetIds.size;
      page += 1
    ) {
      const response = await fetchStandings(
        leagueId,
        page,
        1,
        options.requestDeadlineMs === undefined ? {} : { deadlineMs: options.requestDeadlineMs },
      );
      nextPage = page + 1;
      const pageRows = toClassicRows(season.seasonCode, eventId, response, crawlStartedAt);
      // A manager can move across the page boundary while a live crawl is in
      // progress. Keep only the later occurrence and count unique target IDs.
      fetchedRows = mergeUniqueTargetManagerRows(fetchedRows, pageRows, targetIds);
      if (!response.standings.has_next) {
        exhausted = true;
        break;
      }
    }
    // `fetchedRows` is intentionally scoped to this bounded invocation. A
    // worker continuation can reach normal standings exhaustion with only the
    // final page(s) in memory even though earlier pages are already durable in
    // `rows`. Do not turn that normal end-of-list into an upstream failure; the
    // durable roster is the coverage authority.
  } catch (error) {
    refreshErrorCode =
      error instanceof FPLClientError && error.status === 429
        ? 'UPSTREAM_RATE_LIMITED'
        : 'UPSTREAM_UNAVAILABLE';
    logWarn('Official classic manager standings refresh failed', {
      eventId,
      leagueId,
      error: error instanceof FPLClientError ? (error.code ?? error.status) : 'unknown',
    });
  }
  let publishedRows: ManagerLiveScoreRow[] = [];
  let durableTargetEntryIds: number[] = [];
  if (fetchedRows.size > 0) {
    const uniqueFetchedRows = Array.from(fetchedRows.values());
    try {
      const cachedPublicationRows = await readCachedRows(
        redis,
        season.seasonCode,
        eventId,
        classicScope,
        uniqueFetchedRows.map((row) => row.entryId),
      );
      const publication = await runPublication(
        managerLivePublicationKey(season.seasonCode, eventId, classicScope),
        async () => {
          // Network pagination happens outside the publication gate. Stamp the
          // rows only after the gate is acquired so a crawl that finishes after
          // an OR write is also ordered after that write during reconciliation.
          const publicationCheckedAt = nowIso();
          const publicationState = await readPublicationState(
            season,
            eventId,
            classicScope,
            uniqueFetchedRows.map((row) => row.entryId),
            rows,
            cachedPublicationRows,
          );
          const latestRows = publicationState.rows;
          const mergedRows = uniqueFetchedRows.map((row) => {
            const latest = latestRows.get(row.entryId);
            const { revision: _revision, ...withoutRevision } = row;
            const restamped = withRevision({
              ...withoutRevision,
              checkedAt: publicationCheckedAt,
              staleAt: plusSeconds(publicationCheckedAt, STALE_SECONDS),
            });
            const candidate = withPreservedOverallRank(restamped, latest?.overallRank);
            return mergeLatestManagerLiveRow(latest, candidate);
          });
          await assertLeaseOwned();
          const checkpointPublished = await writeCheckpoint(
            season,
            eventId,
            classicScope,
            mergedRows,
          );
          if (!checkpointPublished) {
            throw new Error('Classic standings checkpoint publication failed');
          }
          return {
            rows: mergedRows,
            cachePublicationOrder: (await readOrderingTimestamp()).exact,
            overallRankPublicationOrders: publicationState.overallRankPublicationStartedAtByEntryId,
          };
        },
      );
      publishedRows = publication.rows;
      await assertLeaseOwned();
      const cacheUpdatedEntryIds = await writeCache(
        redis,
        season.seasonCode,
        eventId,
        classicScope,
        publishedRows,
        {
          season: season.seasonCode,
          eventId,
          source: 'FPL_CLASSIC_STANDINGS',
          leagueId,
          rowCount: publishedRows.length,
          checkedAt: publishedRows[0]?.checkedAt ?? nowIso(),
          revision: publishedRows[0]?.revision ?? null,
          nextRefreshAt: new Date(Date.now() + REFRESH_SECONDS * 1000).toISOString(),
        },
        `classic:${leagueId}:pages:${startPage}-${Math.max(startPage, nextPage - 1)}`,
        publication.cachePublicationOrder,
        publication.overallRankPublicationOrders,
      );
      const responseRows = await reconcileCache(
        redis,
        season,
        eventId,
        classicScope,
        publishedRows,
        cacheUpdatedEntryIds,
      );
      for (const row of responseRows) rows.set(row.entryId, row);
    } catch (error) {
      refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
      if (redis === null) {
        // A cache outage should not prevent the PostgreSQL checkpoint from
        // accepting completed pages. This fallback retains page progress while
        // still refusing to advance when the durable write itself fails.
        const fallbackRows = uniqueFetchedRows.map((row) =>
          withPreservedOverallRank(row, rows.get(row.entryId)?.overallRank),
        );
        const fallbackPublished = await writeCheckpoint(
          season,
          eventId,
          classicScope,
          fallbackRows,
        );
        if (fallbackPublished) {
          publishedRows = fallbackRows;
          for (const row of fallbackRows) rows.set(row.entryId, row);
          logDebug('Official classic standings checkpoint published without Redis', {
            eventId,
            leagueId,
            count: fallbackRows.length,
          });
        } else {
          nextPage = startPage;
        }
      } else {
        // No row can be reported refreshed unless its durable checkpoint write
        // completed. Restart pagination from this batch's first page so a later
        // retry cannot skip rows that existed only in process memory.
        nextPage = startPage;
      }
      logWarn('Official classic manager standings publication failed', {
        eventId,
        leagueId,
        error: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  durableTargetEntryIds = Array.from(targetIds).filter((entryId) => {
    const row = rows.get(entryId);
    return row !== undefined && typeof row.eventPoints === 'number';
  });
  if (
    !refreshErrorCode &&
    !exhausted &&
    nextPage > MAX_STANDINGS_PAGES &&
    fetchedRows.size < targetIds.size &&
    durableTargetEntryIds.length < targetIds.size
  ) {
    refreshErrorCode = 'UPSTREAM_UNAVAILABLE';
  } else if (
    !refreshErrorCode &&
    exhausted &&
    fetchedRows.size < targetIds.size &&
    durableTargetEntryIds.length < targetIds.size
  ) {
    // A normal end-of-list can still miss a target when the manager crossed a
    // page boundary while this multi-job crawl was in progress. Do not persist
    // the terminal cursor in that case: the next bounded invocation must restart
    // from page one and give the moved entry a chance to be observed again.
    nextPage = 1;
    refreshErrorCode = 'UPSTREAM_UNAVAILABLE';
  }

  logDebug('Official classic manager live refresh completed', {
    eventId,
    leagueId,
    requested: targetIds.size,
    fetched: fetchedRows.size,
    published: publishedRows.length,
    partial: refreshErrorCode !== null,
  });
  const result = {
    complete:
      refreshErrorCode === null &&
      (fetchedRows.size >= targetIds.size ||
        ((exhausted || nextPage > MAX_STANDINGS_PAGES) &&
          durableTargetEntryIds.length >= targetIds.size)),
    nextPage,
    errorCode: refreshErrorCode,
    refreshedEntryIds: publishedRows.map((row) => row.entryId),
  };
  return result;
};

export const preserveClassicOverallRank = (
  incoming: CachedRow,
  existing: CachedRow | undefined,
): CachedRow =>
  withOverallRank(
    incoming,
    preserveLastKnownOverallRank(incoming.overallRank, existing?.overallRank),
  );

export const enrichClassicStandingOverallRank = (
  existing: CachedRow,
  overallRank: number | null | undefined,
): CachedRow & { revisionAt: string } => {
  const enriched = withOverallRank(
    existing,
    typeof overallRank === 'number' && Number.isSafeInteger(overallRank) && overallRank > 0
      ? overallRank
      : existing.overallRank,
  );
  const existingRevisionAt = Date.parse(
    (existing as CachedRow & { revisionAt?: string }).revisionAt ?? existing.checkedAt,
  );
  return {
    ...enriched,
    revisionAt: new Date(
      Math.max(Date.now(), Number.isFinite(existingRevisionAt) ? existingRevisionAt + 1 : 0),
    ).toISOString(),
  };
};

export const selectWorkerClassicFallbackTargets = (
  pendingEntryIds: readonly number[],
  rows: ReadonlyMap<number, Pick<CachedRow, 'source'>>,
  standingsComplete: boolean,
): number[] =>
  standingsComplete
    ? pendingEntryIds.filter((entryId) => rows.get(entryId)?.source !== 'FPL_CLASSIC_STANDINGS')
    : [];

export const selectWorkerSummaryRefreshTargets = (
  entryIds: readonly number[],
  limit: number,
  rotationCursor: number,
): number[] => {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const normalized = Array.from(new Set(entryIds)).sort((left, right) => left - right);
  if (normalized.length <= limit) return normalized;
  const chunkCount = Math.ceil(normalized.length / limit);
  const cursor = Number.isSafeInteger(rotationCursor) ? Math.max(0, rotationCursor) : 0;
  const start = (cursor % chunkCount) * limit;
  return normalized.slice(start, start + limit);
};

export const selectClassicOverallRankRefreshTargets = (
  entryIds: readonly number[],
  rows: ReadonlyMap<number, Pick<CachedRow, 'source' | 'overallRank'>>,
  limit: number,
  rotationCursor: number,
): number[] => {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const normalized = Array.from(new Set(entryIds)).sort((left, right) => left - right);
  const missing = normalized.filter((entryId) =>
    classicStandingNeedsOverallRank(rows.get(entryId)),
  );
  const enriched = normalized.filter((entryId) => {
    const row = rows.get(entryId);
    return row?.source === 'FPL_CLASSIC_STANDINGS' && isPositiveOverallRank(row.overallRank);
  });
  const cursor = Number.isSafeInteger(rotationCursor) ? Math.max(0, rotationCursor) : 0;
  const rotatedTake = (values: readonly number[], count: number): number[] => {
    if (values.length === 0 || count <= 0) return [];
    const take = Math.min(values.length, count);
    const start = ((cursor % values.length) * take) % values.length;
    return Array.from({ length: take }, (_, offset) => values[(start + offset) % values.length]!);
  };
  const missingLimit = enriched.length > 0 ? Math.max(1, limit - 1) : limit;
  const selected = rotatedTake(missing, missingLimit);
  selected.push(...rotatedTake(enriched, limit - selected.length));
  return selected;
};
