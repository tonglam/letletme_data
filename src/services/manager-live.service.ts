import { createHash } from 'node:crypto';

import type Redis from 'ioredis';

import { fplClient, type RawFPLLeagueStandingsResponse } from '../clients/fpl';
import { redisSingleton } from '../cache/singleton';
import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import {
  managerScoreCheckpointRepository,
  type ManagerScoreCheckpoint,
  type ManagerScoreScope,
} from '../repositories/live-window';
import { managerEventScoreSnapshotsInFpl } from '../db/schemas/live-window.schema';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { FPLClientError, ValidationError } from '../utils/errors';
import { logDebug, logWarn } from '../utils/logger';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  createKeyedSerialTaskGate,
  createManagerSummaryFetchGate,
  isPositiveOverallRank,
  managerSummaryFetchBatches,
  pendingOverallRankRefreshEntryIds,
  type ManagerSummaryFetchPriority,
  planClassicManagerFallback,
  planClassicOverallRankRefresh,
  preserveLastKnownOverallRank,
  selectLatestCheckedRow,
  shouldRefreshClassicOverallRank,
} from '../domain/manager-live-fallback';

const CACHE_TTL_SECONDS = 48 * 60 * 60;
// Refresh at 30s while an event is active, but keep a successfully published
// official row fresh for at least three refresh cycles. This prevents a
// transient refresh miss from being presented as stale immediately.
const REFRESH_SECONDS = 30;
const STALE_SECONDS = Math.max(90, 3 * REFRESH_SECONDS);
const MAX_STANDINGS_PAGES = 20;
const MAX_FOREGROUND_STANDINGS_PAGES = 4;
const MAX_FOREGROUND_SUMMARY_FETCHES = 4;

export type ManagerLiveSource = 'FPL_ENTRY_SUMMARY' | 'FPL_CLASSIC_STANDINGS' | 'FPL_FINAL_RESULT';
export type ManagerLiveTotalScope = 'OVERALL' | 'CLASSIC_PHASE';

export type ManagerLiveScoreRow = {
  season: string;
  eventId: number;
  entryId: number;
  eventPoints: number | null;
  netEventPoints: number | null;
  totalPoints: number | null;
  totalScope: ManagerLiveTotalScope;
  eventRank: number | null;
  overallRank: number | null;
  leagueRank: number | null;
  source: ManagerLiveSource;
  transferCost: number | null;
  eventPointSemantics: 'GROSS' | 'NET' | 'ZERO_COST_EQUIVALENT' | 'UNKNOWN';
  revision: string;
  checkedAt: string;
  upstreamUpdatedAt: string | null;
  staleAt: string;
};

export type ManagerLiveResolveResult = {
  season: string;
  eventId: number;
  rows: ManagerLiveScoreRow[];
  missingEntryIds: number[];
  partial: boolean;
  errorCode: 'UNSUPPORTED_H2H_LIVE' | 'UPSTREAM_UNAVAILABLE' | 'UPSTREAM_RATE_LIMITED' | null;
  checkedAt: string;
  nextRefreshAt: string;
};

type CachedRow = ManagerLiveScoreRow;
type ManagerSummaryRefreshError = 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null;
type EntrySummaryRefreshResult = {
  errorCode: ManagerSummaryRefreshError;
  refreshedEntryIds: readonly number[];
  overallRankRefreshedEntryIds: readonly number[];
};

const entryScope: ManagerScoreScope = { scopeType: 'ENTRY', scopeId: 0 };

const scopeKey = (scope: ManagerScoreScope): string => `${scope.scopeType}:${scope.scopeId}`;

const cacheKey = (season: string, eventId: number, scope: ManagerScoreScope): string =>
  `OfficialManagerLive:${season}:${eventId}:${scopeKey(scope)}`;
const metaCacheKey = (season: string, eventId: number, scope: ManagerScoreScope): string =>
  `OfficialManagerLiveMeta:${season}:${eventId}:${scopeKey(scope)}`;

const stableRevision = (row: Omit<ManagerLiveScoreRow, 'revision'>): string => {
  const digest = createHash('sha1')
    .update(
      JSON.stringify({
        eventId: row.eventId,
        entryId: row.entryId,
        eventPoints: row.eventPoints,
        netEventPoints: row.netEventPoints,
        totalPoints: row.totalPoints,
        totalScope: row.totalScope,
        eventRank: row.eventRank,
        overallRank: row.overallRank,
        leagueRank: row.leagueRank,
        source: row.source,
        transferCost: row.transferCost,
        eventPointSemantics: row.eventPointSemantics,
        upstreamUpdatedAt: row.upstreamUpdatedAt,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  // A manager revision is a content revision, not a polling timestamp. This
  // lets all three desks share a stable cache key during a quiet interval.
  return digest;
};

const withRevision = (row: Omit<ManagerLiveScoreRow, 'revision'>): ManagerLiveScoreRow => ({
  ...row,
  revision: stableRevision(row),
});

const withPreservedOverallRank = (
  row: ManagerLiveScoreRow,
  previousOverallRank: number | null | undefined,
): ManagerLiveScoreRow => {
  const overallRank = preserveLastKnownOverallRank(row.overallRank, previousOverallRank);
  if (overallRank === row.overallRank) return row;

  const { revision: _revision, ...withoutRevision } = row;
  return withRevision({ ...withoutRevision, overallRank });
};

const mergeLatestManagerLiveRow = (
  current: CachedRow | undefined,
  candidate: CachedRow,
): CachedRow => {
  const latest = selectLatestCheckedRow(current, candidate);
  const other = latest === candidate ? current : candidate;
  return withPreservedOverallRank(latest, other?.overallRank);
};

const toManagerScoreCheckpoint = (row: ManagerLiveScoreRow): ManagerScoreCheckpoint => ({
  entryId: row.entryId,
  eventPoints: row.eventPoints,
  netEventPoints: row.netEventPoints,
  totalPoints: row.totalPoints,
  totalScope: row.totalScope,
  eventRank: row.eventRank,
  overallRank: row.overallRank,
  leagueRank: row.leagueRank,
  source: row.source,
  transferCost: row.transferCost,
  eventPointSemantics: row.eventPointSemantics,
  contentRevision: row.revision,
  checkedAt: new Date(row.checkedAt),
  upstreamUpdatedAt: row.upstreamUpdatedAt ? new Date(row.upstreamUpdatedAt) : null,
});

const fromManagerScoreCheckpoint = (
  row: typeof managerEventScoreSnapshotsInFpl.$inferSelect,
  seasonCode: string,
): CachedRow => ({
  season: seasonCode,
  eventId: row.eventId,
  entryId: row.entryId,
  eventPoints: row.eventPoints,
  netEventPoints: row.netEventPoints,
  totalPoints: row.totalPoints,
  totalScope: row.totalScope as ManagerLiveTotalScope,
  eventRank: row.eventRank,
  overallRank: row.overallRank,
  leagueRank: row.leagueRank,
  source: row.source as ManagerLiveSource,
  transferCost: row.transferCost,
  eventPointSemantics: row.eventPointSemantics as ManagerLiveScoreRow['eventPointSemantics'],
  checkedAt: row.checkedAt.toISOString(),
  upstreamUpdatedAt: row.upstreamUpdatedAt?.toISOString() ?? null,
  staleAt: plusSeconds(row.checkedAt.toISOString(), STALE_SECONDS),
  revision: row.contentRevision,
});

const parseCachedRow = (value: string | null): CachedRow | null => {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const row = parsed as Partial<CachedRow>;
    if (
      typeof row.season !== 'string' ||
      !Number.isSafeInteger(row.eventId) ||
      !Number.isSafeInteger(row.entryId) ||
      typeof row.checkedAt !== 'string' ||
      typeof row.revision !== 'string' ||
      (row.source !== 'FPL_ENTRY_SUMMARY' &&
        row.source !== 'FPL_CLASSIC_STANDINGS' &&
        row.source !== 'FPL_FINAL_RESULT')
    ) {
      return null;
    }
    if (
      typeof row.staleAt !== 'string' ||
      (row.netEventPoints !== undefined &&
        row.netEventPoints !== null &&
        typeof row.netEventPoints !== 'number') ||
      (row.eventPointSemantics !== 'GROSS' &&
        row.eventPointSemantics !== 'NET' &&
        row.eventPointSemantics !== 'ZERO_COST_EQUIVALENT' &&
        row.eventPointSemantics !== 'UNKNOWN')
    ) {
      return null;
    }
    return { ...(row as CachedRow), netEventPoints: row.netEventPoints ?? null };
  } catch {
    return null;
  }
};

const readCachedRows = async (
  redis: Redis | null,
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
  entryIds: readonly number[],
): Promise<Map<number, CachedRow>> => {
  if (!redis || entryIds.length === 0) return new Map();
  const values = await redis.hmget(cacheKey(season, eventId, scope), ...entryIds.map(String));
  const rows = new Map<number, CachedRow>();
  for (let index = 0; index < entryIds.length; index += 1) {
    const row = parseCachedRow(values[index] ?? null);
    if (row) rows.set(entryIds[index], row);
  }
  return rows;
};

const readCachedAndCheckpointRows = async (
  redis: Redis | null,
  season: FplSeasonRef,
  eventId: number,
  scope: ManagerScoreScope,
  entryIds: readonly number[],
  seedRows?: ReadonlyMap<number, CachedRow>,
): Promise<Map<number, CachedRow>> => {
  const wantedEntryIds = new Set(entryIds);
  const rows = new Map<number, CachedRow>();
  for (const [entryId, row] of seedRows ?? []) {
    if (wantedEntryIds.has(entryId)) rows.set(entryId, row);
  }

  try {
    const cachedRows = await readCachedRows(redis, season.seasonCode, eventId, scope, entryIds);
    for (const [entryId, row] of cachedRows) {
      rows.set(entryId, mergeLatestManagerLiveRow(rows.get(entryId), row));
    }
  } catch (error) {
    logWarn('Official manager Redis read failed; using PostgreSQL checkpoint', {
      eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  const checkpoints = await managerScoreCheckpointRepository
    .findByScopeAndEntryIds(season, eventId, scope, entryIds)
    .catch((error) => {
      logWarn('Official manager PostgreSQL checkpoint read failed', {
        eventId,
        scope: scopeKey(scope),
        error: error instanceof Error ? error.message : 'unknown',
      });
      return [];
    });
  for (const checkpoint of checkpoints) {
    const checkpointRow = fromManagerScoreCheckpoint(checkpoint, season.seasonCode);
    rows.set(
      checkpoint.entryId,
      mergeLatestManagerLiveRow(rows.get(checkpoint.entryId), checkpointRow),
    );
  }
  return rows;
};

const writeRows = async (
  redis: Redis | null,
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
  rows: readonly ManagerLiveScoreRow[],
  metadata?: Record<string, unknown>,
  metadataField = 'publication',
): Promise<void> => {
  if (!redis || (rows.length === 0 && !metadata)) return;
  try {
    const key = cacheKey(season, eventId, scope);
    // Use a Redis transaction so a row publication and its metadata become
    // visible together; readers never observe a half-published page.
    const pipeline = redis.multi();
    for (const row of rows) pipeline.hset(key, String(row.entryId), JSON.stringify(row));
    if (rows.length > 0) pipeline.expire(key, CACHE_TTL_SECONDS);
    if (metadata) {
      const metaKey = metaCacheKey(season, eventId, scope);
      pipeline.hset(metaKey, metadataField, JSON.stringify(metadata));
      pipeline.expire(metaKey, CACHE_TTL_SECONDS);
    }
    await pipeline.exec();
  } catch (error) {
    logWarn('Official manager Redis write failed; PostgreSQL checkpoint remains authoritative', {
      season,
      eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};

const writeCheckpointRows = async (
  season: FplSeasonRef,
  eventId: number,
  scope: ManagerScoreScope,
  rows: readonly ManagerLiveScoreRow[],
): Promise<void> => {
  await managerScoreCheckpointRepository
    .upsertBatch(
      season,
      eventId,
      scope,
      rows.map((row) => toManagerScoreCheckpoint(row)),
    )
    .catch((error) =>
      logWarn('Official manager checkpoint write failed', {
        eventId,
        scope: scopeKey(scope),
        error: error instanceof Error ? error.message : 'unknown',
      }),
    );
};

const nowIso = (): string => new Date().toISOString();

const plusSeconds = (checkedAt: string, seconds: number): string =>
  new Date(Date.parse(checkedAt) + seconds * 1000).toISOString();

const toEntrySummaryRow = (
  season: string,
  eventId: number,
  entryId: number,
  summary: Awaited<ReturnType<typeof fplClient.getEntrySummary>>,
  checkedAt: string,
): ManagerLiveScoreRow =>
  withRevision({
    season,
    eventId,
    entryId,
    eventPoints: summary.summary_event_points ?? null,
    netEventPoints: null,
    totalPoints: summary.summary_overall_points ?? null,
    totalScope: 'OVERALL',
    eventRank: summary.summary_event_rank ?? null,
    overallRank: summary.summary_overall_rank ?? null,
    leagueRank: null,
    source: 'FPL_ENTRY_SUMMARY',
    transferCost: null,
    eventPointSemantics: 'UNKNOWN',
    checkedAt,
    upstreamUpdatedAt: null,
    staleAt: plusSeconds(checkedAt, STALE_SECONDS),
  });

const toClassicRows = (
  season: string,
  eventId: number,
  response: RawFPLLeagueStandingsResponse,
  checkedAt: string,
): ManagerLiveScoreRow[] => {
  const upstreamUpdatedAt = response.last_updated_data ?? null;
  return response.standings.results
    .map((result) => {
      const entryId = result.entry;
      if (typeof entryId !== 'number' || !Number.isSafeInteger(entryId) || entryId <= 0)
        return null;
      return withRevision({
        season,
        eventId,
        entryId,
        eventPoints: result.event_total ?? null,
        netEventPoints: null,
        totalPoints: result.total ?? null,
        totalScope: 'CLASSIC_PHASE',
        eventRank: null,
        overallRank: null,
        leagueRank: result.rank ?? null,
        source: 'FPL_CLASSIC_STANDINGS',
        transferCost: null,
        eventPointSemantics: 'UNKNOWN',
        checkedAt,
        upstreamUpdatedAt,
        staleAt: plusSeconds(checkedAt, STALE_SECONDS),
      });
    })
    .filter((row): row is ManagerLiveScoreRow => row !== null);
};

const ageSeconds = (checkedAt: string, now = Date.now()): number => {
  const timestamp = Date.parse(checkedAt);
  return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 1000) : Infinity;
};

const isFresh = (row: CachedRow, now = Date.now()): boolean =>
  ageSeconds(row.checkedAt, now) <= REFRESH_SECONDS;
const isWithinStaleWindow = (row: CachedRow, now = Date.now()): boolean =>
  // Redis expiry is an operational cleanup mechanism. A successful official
  // row remains the last-good value until a newer official or final result
  // replaces it; it must not disappear merely because 90 seconds elapsed.
  Number.isFinite(Date.parse(row.checkedAt)) && ageSeconds(row.checkedAt, now) >= 0;

const managerLiveBackgroundInFlight = new Map<string, Promise<void>>();
// This gate is shared by every live-desk refresh in the process. Per-request
// batching alone is insufficient because distinct tournaments can refresh at
// the same time and otherwise multiply FPL entry-summary concurrency.
const runManagerSummaryFetch = createManagerSummaryFetchGate();
// FPL requests remain concurrent, but publication for one Classic scope is
// serialized. This makes the latest-row read and the following Redis/Postgres
// write one process-local critical section shared by foreground standings and
// deferred rank enrichment.
const runManagerLivePublication = createKeyedSerialTaskGate();
const managerLivePublicationKey = (
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
): string => `${season}:${eventId}:${scopeKey(scope)}`;

const scheduleBackgroundRefresh = (key: string, task: () => Promise<void>): void => {
  if (managerLiveBackgroundInFlight.has(key)) return;
  const promise = task()
    .catch((error) => {
      logWarn('Official manager live background refresh failed', {
        key,
        error: error instanceof FPLClientError ? (error.code ?? error.status) : 'unknown',
      });
    })
    .finally(() => {
      managerLiveBackgroundInFlight.delete(key);
    });
  managerLiveBackgroundInFlight.set(key, promise);
};

const refreshEntrySummaries = async (
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  rows: Map<number, CachedRow>,
  redis: Redis | null,
  scope: ManagerScoreScope = entryScope,
  options: {
    maxFetches?: number;
    priority?: ManagerSummaryFetchPriority;
    force?: boolean;
    preserveClassicStanding?: boolean;
  } = {},
): Promise<EntrySummaryRefreshResult> => {
  const targets = entryIds
    .filter((entryId) => options.force || !rows.has(entryId) || !isFresh(rows.get(entryId)!))
    .slice(0, options.maxFetches ?? Number.POSITIVE_INFINITY);
  if (targets.length === 0) {
    return { errorCode: null, refreshedEntryIds: [], overallRankRefreshedEntryIds: [] };
  }

  const refreshed: ManagerLiveScoreRow[] = [];
  const refreshedEntryIds: number[] = [];
  const overallRankRefreshedEntryIds: number[] = [];
  let refreshErrorCode: ManagerSummaryRefreshError = null;
  const classicScope = scope.scopeType === 'CLASSIC_LEAGUE';
  const publicationKey = managerLivePublicationKey(season.seasonCode, eventId, scope);
  for (const batch of managerSummaryFetchBatches(targets)) {
    const publishedBatch: ManagerLiveScoreRow[] = [];
    const checkpointBatch: ManagerLiveScoreRow[] = [];
    await Promise.all(
      batch.map(async (entryId) => {
        try {
          const summary = await runManagerSummaryFetch(
            () => fplClient.getEntrySummary(entryId),
            options.priority,
          );
          const composeAndPublish = async (reReadLatest: boolean): Promise<ManagerLiveScoreRow> => {
            let existing = rows.get(entryId);
            if (reReadLatest) {
              // The shared Classic publication gate keeps the latest-row read,
              // OR merge, Redis write and checkpoint upsert atomic relative to
              // every foreground standings publication in this API process.
              const latestRows = await readCachedAndCheckpointRows(
                redis,
                season,
                eventId,
                scope,
                [entryId],
                rows,
              );
              existing = latestRows.get(entryId) ?? existing;
              if (existing) rows.set(entryId, existing);
            }
            const checkedAt = nowIso();
            const candidate =
              (options.preserveClassicStanding || classicScope) &&
              existing?.source === 'FPL_CLASSIC_STANDINGS'
                ? (() => {
                    const { revision: _revision, ...classicRow } = existing;
                    return withRevision({
                      ...classicRow,
                      // Classic standings owns event/phase totals and league rank;
                      // the entry summary owns the season-wide FPL OR.
                      overallRank: summary.summary_overall_rank ?? null,
                      checkedAt,
                      staleAt: plusSeconds(checkedAt, STALE_SECONDS),
                    });
                  })()
                : toEntrySummaryRow(season.seasonCode, eventId, entryId, summary, checkedAt);
            const row = withPreservedOverallRank(candidate, existing?.overallRank);
            rows.set(row.entryId, row);
            // Publish each completed response immediately. A slow sibling or
            // later batch must not hide already-fetched official scores.
            await writeRows(redis, season.seasonCode, eventId, scope, [row]);
            if (classicScope) await writeCheckpointRows(season, eventId, scope, [row]);
            return row;
          };
          const row = classicScope
            ? await runManagerLivePublication(publicationKey, () => composeAndPublish(true))
            : await composeAndPublish(false);
          if (isPositiveOverallRank(summary.summary_overall_rank)) {
            overallRankRefreshedEntryIds.push(entryId);
          }
          refreshedEntryIds.push(entryId);
          publishedBatch.push(row);
          if (!classicScope) checkpointBatch.push(row);
          refreshed.push(row);
        } catch (error) {
          if (error instanceof FPLClientError && error.status === 429) {
            refreshErrorCode = 'UPSTREAM_RATE_LIMITED';
          } else {
            refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
          }
          logWarn('Official manager entry summary refresh failed', {
            entryId,
            eventId,
            error: error instanceof FPLClientError ? (error.code ?? error.status) : 'unknown',
          });
        }
      }),
    );
    if (publishedBatch.length === 0) continue;

    const checkedAt = refreshed.reduce(
      (latest, row) => (row.checkedAt > latest ? row.checkedAt : latest),
      refreshed[0]!.checkedAt,
    );
    await writeRows(
      redis,
      season.seasonCode,
      eventId,
      scope,
      [],
      {
        season: season.seasonCode,
        eventId,
        source: 'FPL_ENTRY_SUMMARY',
        rowCount: refreshed.length,
        checkedAt,
        revision: refreshed[0]!.revision,
        nextRefreshAt: new Date(Date.now() + REFRESH_SECONDS * 1000).toISOString(),
      },
      'entry-summary',
    );
    await writeCheckpointRows(season, eventId, scope, checkpointBatch);
  }
  return {
    errorCode: refreshErrorCode,
    refreshedEntryIds,
    overallRankRefreshedEntryIds,
  };
};

const refreshClassicStandings = async (
  season: FplSeasonRef,
  eventId: number,
  leagueId: number,
  targetIds: ReadonlySet<number>,
  rows: Map<number, CachedRow>,
  redis: Redis | null,
  options: { startPage?: number; maxPages?: number } = {},
): Promise<{
  complete: boolean;
  nextPage: number;
  errorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null;
  refreshedEntryIds: readonly number[];
}> => {
  const checkedAt = nowIso();
  const fetchedRows: ManagerLiveScoreRow[] = [];
  const classicScope: ManagerScoreScope = { scopeType: 'CLASSIC_LEAGUE', scopeId: leagueId };
  let found = 0;
  const startPage = options.startPage ?? 1;
  const maxPages = options.maxPages ?? MAX_FOREGROUND_STANDINGS_PAGES;
  let nextPage = startPage;
  let exhausted = false;
  let refreshErrorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null = null;
  try {
    for (
      let page = startPage;
      page <= MAX_STANDINGS_PAGES && page < startPage + maxPages && found < targetIds.size;
      page += 1
    ) {
      const response = await fplClient.getLeagueClassicStandings(leagueId, page);
      nextPage = page + 1;
      const pageRows = toClassicRows(season.seasonCode, eventId, response, checkedAt);
      for (const row of pageRows) {
        if (!targetIds.has(row.entryId)) continue;
        const previous = rows.get(row.entryId);
        if (!previous || !isFresh(previous)) found += 1;
        fetchedRows.push(row);
        rows.set(row.entryId, withPreservedOverallRank(row, previous?.overallRank));
      }
      if (!response.standings.has_next) {
        exhausted = true;
        break;
      }
    }
    const publishedRows = await runManagerLivePublication(
      managerLivePublicationKey(season.seasonCode, eventId, classicScope),
      async () => {
        const latestRows = await readCachedAndCheckpointRows(
          redis,
          season,
          eventId,
          classicScope,
          fetchedRows.map((row) => row.entryId),
          rows,
        );
        const mergedRows = fetchedRows.map((row) => {
          const latest = latestRows.get(row.entryId);
          const candidate = withPreservedOverallRank(row, latest?.overallRank);
          const merged = mergeLatestManagerLiveRow(latest, candidate);
          rows.set(merged.entryId, merged);
          return merged;
        });
        const publicationCheckedAt = mergedRows.reduce(
          (latest, row) => (row.checkedAt > latest ? row.checkedAt : latest),
          checkedAt,
        );
        await writeRows(
          redis,
          season.seasonCode,
          eventId,
          classicScope,
          mergedRows,
          mergedRows.length > 0
            ? {
                season: season.seasonCode,
                eventId,
                source: 'FPL_CLASSIC_STANDINGS',
                leagueId,
                rowCount: mergedRows.length,
                checkedAt: publicationCheckedAt,
                revision: mergedRows[0]?.revision ?? null,
                nextRefreshAt: new Date(Date.now() + REFRESH_SECONDS * 1000).toISOString(),
              }
            : undefined,
          `classic:${leagueId}:pages:${startPage}-${Math.max(startPage, nextPage - 1)}`,
        );
        await writeCheckpointRows(season, eventId, classicScope, mergedRows);
        return mergedRows;
      },
    );
    logDebug('Official classic manager live refresh completed', {
      eventId,
      leagueId,
      requested: targetIds.size,
      fetched: publishedRows.length,
    });
    return {
      complete: exhausted || found >= targetIds.size || nextPage > MAX_STANDINGS_PAGES,
      nextPage,
      errorCode: null,
      refreshedEntryIds: fetchedRows.map((row) => row.entryId),
    };
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
    return {
      complete: false,
      nextPage,
      errorCode: refreshErrorCode,
      refreshedEntryIds: fetchedRows.map((row) => row.entryId),
    };
  }
};

const nextRefresh = (eventFinished: boolean): string =>
  new Date(Date.now() + (eventFinished ? 60_000 : 30_000)).toISOString();

const finalResultRows = async (
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  freshAfter: Date | null,
): Promise<CachedRow[]> => {
  const results = await entryEventResultsRepository.findByEventAndEntryIds(
    season,
    eventId,
    Array.from(new Set(entryIds)),
  );
  const checkedAt = nowIso();
  const freshAfterMs = freshAfter?.getTime() ?? null;
  return results
    .filter(
      (result) =>
        result.richSyncedAt !== null &&
        (freshAfterMs === null || result.richSyncedAt.getTime() >= freshAfterMs),
    )
    .map((result) =>
      withRevision({
        season: season.seasonCode,
        eventId,
        entryId: result.entryId,
        eventPoints: result.eventPoints,
        netEventPoints: result.eventNetPoints,
        totalPoints: result.overallPoints,
        totalScope: 'OVERALL',
        eventRank: result.eventRank,
        overallRank: result.overallRank,
        leagueRank: null,
        source: 'FPL_FINAL_RESULT',
        transferCost: result.eventTransfersCost,
        eventPointSemantics: 'GROSS',
        checkedAt,
        upstreamUpdatedAt: result.richSyncedAt?.toISOString() ?? null,
        staleAt: plusSeconds(checkedAt, STALE_SECONDS),
      }),
    );
};

const managerLiveInFlight = new Map<string, Promise<ManagerLiveResolveResult>>();

const resolveManagerLiveScoresUncoalesced = async (input: {
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
}): Promise<ManagerLiveResolveResult> => {
  const season = await seasonRepository.findCurrent();
  const uniqueEntryIds = Array.from(new Set(input.entryIds));
  if (
    !Number.isSafeInteger(input.eventId) ||
    input.eventId <= 0 ||
    uniqueEntryIds.length === 0 ||
    uniqueEntryIds.length > 500 ||
    uniqueEntryIds.some((entryId) => !Number.isSafeInteger(entryId) || entryId <= 0)
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
  if (input.tournamentId !== undefined) {
    tournament = await tournamentInfoRepository.findById(season, input.tournamentId);
    if (!tournament) {
      throw new ValidationError(
        'Tournament does not belong to the active season.',
        'MANAGER_LIVE_TOURNAMENT_INVALID',
      );
    }
    const roster = new Set(
      await tournamentEntryRepository.findEntryIdsByTournamentId(season, input.tournamentId),
    );
    if (uniqueEntryIds.some((entryId) => !roster.has(entryId))) {
      throw new ValidationError(
        'Entry is not a member of the tournament.',
        'MANAGER_LIVE_ENTRY_NOT_IN_TOURNAMENT',
      );
    }
    if (tournament.leagueType === 'classic') {
      scope = { scopeType: 'CLASSIC_LEAGUE', scopeId: tournament.leagueId };
    }
  }

  // A finished/data-checked event is historical data. Do not call the current
  // FPL manager endpoint for it; the final result table is the authority.
  if (event.finished && event.dataChecked) {
    const finalRows = await finalResultRows(
      season,
      input.eventId,
      uniqueEntryIds,
      event.dataCheckedAt,
    );
    const resolvedIds = new Set(finalRows.map((row) => row.entryId));
    const checkpointRows =
      resolvedIds.size === uniqueEntryIds.length
        ? []
        : await managerScoreCheckpointRepository
            .findByScopeAndEntryIds(
              season,
              input.eventId,
              scope,
              uniqueEntryIds.filter((entryId) => !resolvedIds.has(entryId)),
            )
            .catch((error) => {
              logWarn('Final manager result fallback checkpoint read failed', {
                eventId: input.eventId,
                scope: scopeKey(scope),
                error: error instanceof Error ? error.message : 'unknown',
              });
              return [];
            });
    const checkpointFallbackRows = checkpointRows
      .filter((row) => !resolvedIds.has(row.entryId))
      .map((row) => fromManagerScoreCheckpoint(row, season.seasonCode));
    const rows = [...finalRows, ...checkpointFallbackRows];
    const resolvedWithFallbackIds = new Set(rows.map((row) => row.entryId));
    return {
      season: season.seasonCode,
      eventId: input.eventId,
      rows,
      missingEntryIds: uniqueEntryIds.filter((entryId) => !resolvedWithFallbackIds.has(entryId)),
      partial: uniqueEntryIds.some((entryId) => !resolvedWithFallbackIds.has(entryId)),
      errorCode: null,
      checkedAt: nowIso(),
      nextRefreshAt: nextRefresh(true),
    };
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
  const rows = await readCachedAndCheckpointRows(
    redis,
    season,
    input.eventId,
    scope,
    uniqueEntryIds,
  );
  const staleOrMissing = uniqueEntryIds.filter(
    (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
  );
  const staleOrMissingIds = new Set(staleOrMissing);
  const classicOverallRankMissing =
    input.tournamentId !== undefined &&
    tournament?.leagueType === 'classic' &&
    uniqueEntryIds.some((entryId) => shouldRefreshClassicOverallRank(rows.get(entryId), false));
  let errorCode: ManagerLiveResolveResult['errorCode'] = null;
  let refreshErrorCode: Exclude<
    ManagerLiveResolveResult['errorCode'],
    'UNSUPPORTED_H2H_LIVE' | null
  > | null = null;

  if (input.tournamentId !== undefined && tournament?.leagueType === 'h2h') {
    // FPL does not expose a live H2H table, but its official entry summary is
    // still a well-defined event score. Use it for provisional pairings and
    // let the final database result replace it after finalization.
    if (staleOrMissing.length > 0) {
      const summaryRefresh = await refreshEntrySummaries(
        season,
        input.eventId,
        staleOrMissing,
        rows,
        redis,
        entryScope,
        { maxFetches: MAX_FOREGROUND_SUMMARY_FETCHES },
      );
      refreshErrorCode = summaryRefresh.errorCode;
      const pending = staleOrMissing.filter(
        (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
      );
      if (pending.length > 0) {
        const backgroundKey = `h2h:${season.seasonCode}:${input.eventId}:${input.tournamentId}:${pending
          .slice()
          .sort((left, right) => left - right)
          .join(',')}`;
        scheduleBackgroundRefresh(backgroundKey, async () => {
          const backgroundRows = await readCachedRows(
            redis,
            season.seasonCode,
            input.eventId,
            entryScope,
            pending,
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
    }
  } else if (
    input.tournamentId !== undefined &&
    (staleOrMissing.length > 0 || classicOverallRankMissing)
  ) {
    if (!tournament) throw new Error('Tournament validation unexpectedly missing');
    const classicLeagueId = tournament.leagueId;
    const standings = await refreshClassicStandings(
      season,
      input.eventId,
      classicLeagueId,
      new Set(staleOrMissing),
      rows,
      redis,
    );
    refreshErrorCode = standings.errorCode;

    const standingsRefreshedEntryIds = new Set(standings.refreshedEntryIds);
    let pendingStandings = staleOrMissing.filter(
      (entryId) => !standingsRefreshedEntryIds.has(entryId),
    );
    const fallbackPlan = planClassicManagerFallback(pendingStandings, standings.complete);
    const fallbackSummaryRefreshedEntryIds = new Set<number>();
    if (fallbackPlan.foregroundSummaryEntryIds.length > 0) {
      const summaryRefresh = await refreshEntrySummaries(
        season,
        input.eventId,
        fallbackPlan.foregroundSummaryEntryIds,
        rows,
        redis,
        scope,
      );
      refreshErrorCode = refreshErrorCode ?? summaryRefresh.errorCode;
      for (const entryId of summaryRefresh.refreshedEntryIds) {
        fallbackSummaryRefreshedEntryIds.add(entryId);
      }
      pendingStandings = fallbackPlan.backgroundEntryIds.filter(
        (entryId) => !fallbackSummaryRefreshedEntryIds.has(entryId),
      );
    }

    // FPL classic standings expose the event/phase totals and the league
    // position, but not the season-wide Overall Rank (OR). Enrich only rows
    // whose standings refresh has completed; deeper standings rows stay in a
    // separate pending set so an OR-only timestamp cannot mark them fresh.
    const classicOverallRankTargets = uniqueEntryIds.filter(
      (entryId) =>
        !fallbackSummaryRefreshedEntryIds.has(entryId) &&
        shouldRefreshClassicOverallRank(rows.get(entryId), staleOrMissingIds.has(entryId)),
    );
    const pendingStandingsEntryIds = new Set(pendingStandings);
    const overallRankPlan = planClassicOverallRankRefresh(
      classicOverallRankTargets,
      classicOverallRankTargets.filter(
        (entryId) =>
          !pendingStandingsEntryIds.has(entryId) &&
          rows.get(entryId)?.source === 'FPL_CLASSIC_STANDINGS',
      ),
    );
    let pendingOverallRank = overallRankPlan.entryIds;
    if (overallRankPlan.foregroundEntryIds.length > 0) {
      const summaryRefresh = await refreshEntrySummaries(
        season,
        input.eventId,
        overallRankPlan.foregroundEntryIds,
        rows,
        redis,
        scope,
        { force: true, preserveClassicStanding: true },
      );
      refreshErrorCode = refreshErrorCode ?? summaryRefresh.errorCode;
      pendingOverallRank = pendingOverallRankRefreshEntryIds(
        overallRankPlan.entryIds,
        summaryRefresh.overallRankRefreshedEntryIds,
      );
    }

    const backgroundEntryIds = Array.from(new Set([...pendingStandings, ...pendingOverallRank]));
    if (backgroundEntryIds.length > 0) {
      const backgroundKey = `classic:${season.seasonCode}:${input.eventId}:${classicLeagueId}`;
      const backgroundSeedRows = new Map(rows);
      scheduleBackgroundRefresh(backgroundKey, async () => {
        const backgroundRows = await readCachedAndCheckpointRows(
          redis,
          season,
          input.eventId,
          scope,
          backgroundEntryIds,
          backgroundSeedRows,
        );

        let unresolvedStandings = pendingStandings;
        let standingsComplete = standings.complete;
        if (fallbackPlan.continueStandings && unresolvedStandings.length > 0) {
          const backgroundStandings = await refreshClassicStandings(
            season,
            input.eventId,
            classicLeagueId,
            new Set(unresolvedStandings),
            backgroundRows,
            redis,
            { startPage: standings.nextPage, maxPages: MAX_STANDINGS_PAGES },
          );
          standingsComplete = backgroundStandings.complete;
          const refreshedStandings = new Set(backgroundStandings.refreshedEntryIds);
          unresolvedStandings = unresolvedStandings.filter(
            (entryId) => !refreshedStandings.has(entryId),
          );
        }

        if (standingsComplete && unresolvedStandings.length > 0) {
          const fallbackRefresh = await refreshEntrySummaries(
            season,
            input.eventId,
            unresolvedStandings,
            backgroundRows,
            redis,
            scope,
            { priority: 'background' },
          );
          const fallbackRefreshed = new Set(fallbackRefresh.refreshedEntryIds);
          unresolvedStandings = unresolvedStandings.filter(
            (entryId) => !fallbackRefreshed.has(entryId),
          );
        }

        const unresolvedStandingsEntryIds = new Set(unresolvedStandings);
        const overallRankTargets = pendingOverallRank.filter(
          (entryId) =>
            !unresolvedStandingsEntryIds.has(entryId) &&
            backgroundRows.get(entryId)?.source === 'FPL_CLASSIC_STANDINGS',
        );
        if (overallRankTargets.length > 0) {
          await refreshEntrySummaries(
            season,
            input.eventId,
            overallRankTargets,
            backgroundRows,
            redis,
            scope,
            { force: true, priority: 'background', preserveClassicStanding: true },
          );
        }

        logDebug('Official classic manager background refresh completed', {
          eventId: input.eventId,
          leagueId: classicLeagueId,
          remainingStandings: unresolvedStandings.length,
          overallRankTargets: overallRankTargets.length,
          complete: standingsComplete,
        });
      });
    }
  }

  if (input.tournamentId === undefined && staleOrMissing.length > 0) {
    const summaryTargets = staleOrMissing;
    const summaryRefresh = await refreshEntrySummaries(
      season,
      input.eventId,
      summaryTargets,
      rows,
      redis,
      entryScope,
      {
        maxFetches: MAX_FOREGROUND_SUMMARY_FETCHES,
      },
    );
    refreshErrorCode = summaryRefresh.errorCode;
    const pending = summaryTargets.filter(
      (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
    );
    if (pending.length > 0) {
      const backgroundKey = `summary:${season.seasonCode}:${input.eventId}`;
      scheduleBackgroundRefresh(backgroundKey, async () => {
        const backgroundRows = await readCachedRows(
          redis,
          season.seasonCode,
          input.eventId,
          entryScope,
          pending,
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

  const now = Date.now();
  const resolvedRows = uniqueEntryIds
    .map((entryId) => rows.get(entryId))
    .filter((row): row is CachedRow => row !== undefined && isWithinStaleWindow(row, now));
  const resolvedIds = new Set(resolvedRows.map((row) => row.entryId));
  const missingEntryIds = uniqueEntryIds.filter((entryId) => !resolvedIds.has(entryId));
  if (!errorCode && refreshErrorCode) errorCode = refreshErrorCode;
  if (!errorCode && missingEntryIds.length > 0) errorCode = 'UPSTREAM_UNAVAILABLE';

  return {
    season: season.seasonCode,
    eventId: input.eventId,
    rows: resolvedRows,
    missingEntryIds,
    partial: missingEntryIds.length > 0,
    errorCode,
    checkedAt: nowIso(),
    nextRefreshAt: nextRefresh(event.finished),
  };
};

/**
 * Single-flight guard for live boards. Concurrent GraphQL requests for the
 * same event/entry set share one bounded upstream refresh instead of creating
 * an FPL request burst.
 */
export async function resolveManagerLiveScores(input: {
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
}): Promise<ManagerLiveResolveResult> {
  const key = JSON.stringify({
    eventId: input.eventId,
    entryIds: Array.from(new Set(input.entryIds)).sort((a, b) => a - b),
    tournamentId: input.tournamentId ?? null,
  });
  const existing = managerLiveInFlight.get(key);
  if (existing) return existing;
  const promise = resolveManagerLiveScoresUncoalesced(input).finally(() => {
    managerLiveInFlight.delete(key);
  });
  managerLiveInFlight.set(key, promise);
  return promise;
}
