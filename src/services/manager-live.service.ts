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
  createManagerSummaryFetchGate,
  managerSummaryFetchBatches,
  type ManagerSummaryFetchPriority,
  planClassicManagerFallback,
} from '../domain/manager-live-fallback';
import {
  MANAGER_LIVE_CLASSIC_MAX_PAGE,
  MANAGER_LIVE_REFRESH_BUCKET_MS,
  MANAGER_LIVE_WORKER_CLASSIC_OR_FETCH_LIMIT,
  MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT,
  MANAGER_LIVE_WORKER_REQUEST_DEADLINE_MS,
  MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT,
} from '../domain/manager-live-refresh';
import { dispatchManagerLiveRefresh } from './manager-live-refresh-dispatch';

const CACHE_TTL_SECONDS = 48 * 60 * 60;
// Refresh at 30s while an event is active, but keep a successfully published
// official row fresh for at least three refresh cycles. This prevents a
// transient refresh miss from being presented as stale immediately.
const REFRESH_SECONDS = 30;
const STALE_SECONDS = Math.max(90, 3 * REFRESH_SECONDS);
const MAX_FOREGROUND_STANDINGS_PAGES = 4;
const MAX_FOREGROUND_SUMMARY_FETCHES = 4;
// A small classic roster should receive a complete OR column in the initial
// response. Larger leagues remain bounded and finish through the background
// refresh below.
const MAX_FOREGROUND_OVERALL_RANK_FETCHES = 20;
const REFRESH_DISPATCH_DEADLINE_MS = 100;

export type ManagerLiveSource = 'FPL_ENTRY_SUMMARY' | 'FPL_CLASSIC_STANDINGS' | 'FPL_FINAL_RESULT';
export type ManagerLiveTotalScope = 'OVERALL' | 'CLASSIC_PHASE';
export type ManagerLiveReadMode = 'CACHE_ONLY' | 'READ_THROUGH';
export type ManagerLiveDataAvailability = 'FRESH' | 'LAST_GOOD' | 'PARTIAL' | 'UNAVAILABLE';
export type ManagerLiveServedFrom = 'REDIS' | 'POSTGRES' | 'MIXED' | 'NONE';

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
  managerRevision: string;
  dataAvailability: ManagerLiveDataAvailability;
  servedFrom: ManagerLiveServedFrom;
  refreshQueued: boolean;
  rows: ManagerLiveScoreRow[];
  missingEntryIds: number[];
  partial: boolean;
  errorCode: 'UNSUPPORTED_H2H_LIVE' | 'UPSTREAM_UNAVAILABLE' | 'UPSTREAM_RATE_LIMITED' | null;
  checkedAt: string;
  nextRefreshAt: string;
  /** Internal worker continuation; absent on public cache-only reads. */
  classicStandingsNextPage?: number | null;
};

// `revisionAt` orders content-only enrichments such as overall rank without
// advancing `checkedAt`, which belongs to the Classic standings freshness
// envelope. It is persisted in Redis and the checkpoint `updated_at` column,
// but stripped from the internal API response below.
type CachedRow = ManagerLiveScoreRow & { revisionAt: string };

const entryScope: ManagerScoreScope = { scopeType: 'ENTRY', scopeId: 0 };

const scopeKey = (scope: ManagerScoreScope): string => `${scope.scopeType}:${scope.scopeId}`;

const cacheKey = (season: string, eventId: number, scope: ManagerScoreScope): string =>
  `OfficialManagerLive:${season}:${eventId}:${scopeKey(scope)}`;
const metaCacheKey = (season: string, eventId: number, scope: ManagerScoreScope): string =>
  `OfficialManagerLiveMeta:${season}:${eventId}:${scopeKey(scope)}`;

const stableRevision = (row: Omit<CachedRow, 'revision'>): string => {
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

const withRevision = (row: Omit<CachedRow, 'revision'>): CachedRow => ({
  ...row,
  revision: stableRevision(row),
});

const toManagerScoreCheckpoint = (row: CachedRow): ManagerScoreCheckpoint => ({
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
  revisionAt: new Date(row.revisionAt),
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
  revisionAt:
    row.updatedAt instanceof Date && Number.isFinite(row.updatedAt.getTime())
      ? row.updatedAt.toISOString()
      : row.checkedAt.toISOString(),
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
      (row.revisionAt !== undefined && typeof row.revisionAt !== 'string') ||
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
    const revisionAt = row.revisionAt ?? row.checkedAt;
    if (!Number.isFinite(Date.parse(revisionAt))) return null;
    return {
      ...(row as CachedRow),
      netEventPoints: row.netEventPoints ?? null,
      revisionAt,
    };
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

const writeRows = async (
  redis: Redis | null,
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
  rows: readonly CachedRow[],
  metadata?: Record<string, unknown>,
  metadataField = 'publication',
): Promise<boolean> => {
  if (!redis || (rows.length === 0 && !metadata)) return false;
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
    const results = await pipeline.exec();
    const commandError = results?.find(([error]) => error !== null)?.[0];
    if (commandError) throw commandError;
    return results !== null;
  } catch (error) {
    logWarn('Official manager Redis write failed; PostgreSQL checkpoint remains authoritative', {
      season,
      eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
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
): CachedRow =>
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
    revisionAt: checkedAt,
    upstreamUpdatedAt: null,
    staleAt: plusSeconds(checkedAt, STALE_SECONDS),
  });

const toClassicRows = (
  season: string,
  eventId: number,
  response: RawFPLLeagueStandingsResponse,
  checkedAt: string,
): CachedRow[] => {
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
        revisionAt: checkedAt,
        upstreamUpdatedAt,
        staleAt: plusSeconds(checkedAt, STALE_SECONDS),
      });
    })
    .filter((row): row is CachedRow => row !== null);
};

export const preserveClassicOverallRank = (
  row: CachedRow,
  existing: CachedRow | undefined,
): CachedRow => {
  if (typeof existing?.overallRank !== 'number' || existing.overallRank <= 0) return row;
  const { revision: _revision, ...classicRow } = row;
  return withRevision({ ...classicRow, overallRank: existing.overallRank });
};

export const enrichClassicStandingOverallRank = (
  existing: CachedRow,
  overallRank: number | null | undefined,
): CachedRow => {
  const { revision: _revision, ...classicRow } = existing;
  const nextOverallRank =
    typeof overallRank === 'number' && Number.isSafeInteger(overallRank) && overallRank > 0
      ? overallRank
      : existing.overallRank;
  // An entry-summary request owns only the season-wide OR. It must not advance
  // the freshness clock for standings event points, phase totals, or league
  // rank that were not fetched in the same request.
  const existingRevisionTime = Date.parse(existing.revisionAt);
  const revisionAt = new Date(
    Math.max(Date.now(), Number.isFinite(existingRevisionTime) ? existingRevisionTime + 1 : 0),
  ).toISOString();
  return withRevision({ ...classicRow, overallRank: nextOverallRank, revisionAt });
};

export const selectWorkerClassicFallbackTargets = (
  pendingEntryIds: readonly number[],
  rows: ReadonlyMap<number, Pick<CachedRow, 'source'>>,
  standingsComplete: boolean,
): number[] =>
  standingsComplete
    ? pendingEntryIds.filter((entryId) => rows.get(entryId)?.source !== 'FPL_CLASSIC_STANDINGS')
    : [];

const ageSeconds = (checkedAt: string, now = Date.now()): number => {
  const timestamp = Date.parse(checkedAt);
  return Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 1000) : Infinity;
};

const isFresh = (row: Pick<ManagerLiveScoreRow, 'checkedAt'>, now = Date.now()): boolean =>
  ageSeconds(row.checkedAt, now) <= REFRESH_SECONDS;
const isWithinStaleWindow = (
  row: Pick<ManagerLiveScoreRow, 'checkedAt'>,
  now = Date.now(),
): boolean =>
  // Redis expiry is an operational cleanup mechanism. A successful official
  // row remains the last-good value until a newer official or final result
  // replaces it; it must not disappear merely because 90 seconds elapsed.
  Number.isFinite(Date.parse(row.checkedAt)) && ageSeconds(row.checkedAt, now) >= 0;

type ManagerLiveRowBacking = 'REDIS' | 'POSTGRES' | 'UPSTREAM';

const managerRevision = (
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

const managerCheckedAt = (rows: readonly ManagerLiveScoreRow[], fallback: string): string => {
  const timestamps = rows
    .map((row) => Date.parse(row.checkedAt))
    .filter((timestamp) => Number.isFinite(timestamp));
  return timestamps.length === 0 ? fallback : new Date(Math.min(...timestamps)).toISOString();
};

const managerDataAvailability = (
  rows: readonly ManagerLiveScoreRow[],
  missingEntryIds: readonly number[],
  now = Date.now(),
): ManagerLiveDataAvailability => {
  if (rows.length === 0) return 'UNAVAILABLE';
  if (missingEntryIds.length > 0) return 'PARTIAL';
  return rows.every((row) => isFresh(row, now)) ? 'FRESH' : 'LAST_GOOD';
};

const managerServedFrom = (
  rows: readonly ManagerLiveScoreRow[],
  sourceByEntry: ReadonlyMap<number, ManagerLiveRowBacking>,
): ManagerLiveServedFrom => {
  const sources = new Set(
    rows
      .map((row) => sourceByEntry.get(row.entryId))
      .filter((source): source is ManagerLiveRowBacking => source !== undefined),
  );
  if (sources.size === 0) return 'NONE';
  // The public contract intentionally describes durable last-good backing and
  // does not add an UPSTREAM enum. A read-through row that has not been read
  // back from Redis/PostgreSQL therefore reports NONE; a response combining
  // upstream rows with durable rows reports MIXED. Never claim REDIS merely
  // because a best-effort cache write was attempted.
  if (sources.has('UPSTREAM')) return sources.size === 1 ? 'NONE' : 'MIXED';
  if (sources.size > 1) return 'MIXED';
  return sources.has('REDIS') ? 'REDIS' : 'POSTGRES';
};

const buildManagerLiveResult = (input: {
  season: string;
  eventId: number;
  rows: CachedRow[];
  missingEntryIds: number[];
  errorCode: ManagerLiveResolveResult['errorCode'];
  nextRefreshAt: string;
  sourceByEntry: ReadonlyMap<number, ManagerLiveRowBacking>;
  refreshQueued?: boolean;
  checkedAt?: string;
  classicStandingsNextPage?: number | null;
}): ManagerLiveResolveResult => {
  const fallbackCheckedAt = input.checkedAt ?? nowIso();
  const publicRows = input.rows.map(({ revisionAt: _revisionAt, ...row }) => row);
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
    rows: publicRows,
    missingEntryIds: input.missingEntryIds,
    partial: input.missingEntryIds.length > 0,
    errorCode: input.errorCode,
    checkedAt: managerCheckedAt(input.rows, fallbackCheckedAt),
    nextRefreshAt: input.nextRefreshAt,
    ...(input.classicStandingsNextPage === undefined
      ? {}
      : { classicStandingsNextPage: input.classicStandingsNextPage }),
  };
};

const dispatchManagerLiveRefreshBounded = async (
  input: Parameters<typeof dispatchManagerLiveRefresh>[0],
): Promise<'QUEUED' | 'PENDING'> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const dispatch = dispatchManagerLiveRefresh(input).catch((error) => {
    if (timedOut) {
      logWarn('Manager live refresh dispatch failed after response deadline', {
        eventId: input.eventId,
        tournamentId: input.tournamentId ?? null,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    throw error;
  });
  try {
    return await Promise.race([
      dispatch.then(() => 'QUEUED' as const),
      new Promise<'PENDING'>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve('PENDING');
        }, REFRESH_DISPATCH_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const managerLiveBackgroundInFlight = new Map<string, Promise<void>>();
// This gate is shared by every live-desk refresh in the process. Per-request
// batching alone is insufficient because distinct tournaments can refresh at
// the same time and otherwise multiply FPL entry-summary concurrency.
const runManagerSummaryFetch = createManagerSummaryFetchGate();

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
    requestDeadlineMs?: number;
  } = {},
): Promise<'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null> => {
  const targets = entryIds
    .filter((entryId) => options.force || !rows.has(entryId) || !isFresh(rows.get(entryId)!))
    .slice(0, options.maxFetches ?? Number.POSITIVE_INFINITY);
  if (targets.length === 0) return null;

  const refreshed: CachedRow[] = [];
  let refreshErrorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null = null;
  for (const batch of managerSummaryFetchBatches(targets)) {
    const completedBatch: CachedRow[] = [];
    const previousBatchRows = new Map<number, CachedRow | undefined>();
    const redisPublishedByEntry = new Map<number, boolean>();
    await Promise.all(
      batch.map(async (entryId) => {
        try {
          const summary = await runManagerSummaryFetch(
            () =>
              fplClient.getEntrySummary(
                entryId,
                options.requestDeadlineMs === undefined
                  ? undefined
                  : { deadlineMs: options.requestDeadlineMs },
              ),
            options.priority,
          );
          const checkedAt = nowIso();
          const existing = rows.get(entryId);
          const row =
            options.preserveClassicStanding && existing?.source === 'FPL_CLASSIC_STANDINGS'
              ? enrichClassicStandingOverallRank(existing, summary.summary_overall_rank)
              : toEntrySummaryRow(season.seasonCode, eventId, entryId, summary, checkedAt);
          previousBatchRows.set(entryId, existing);
          completedBatch.push(row);
          refreshed.push(row);
          rows.set(row.entryId, row);
          // Publish each completed response to the primary cache immediately.
          // A slow sibling or later batch must not hide already-fetched
          // official scores until the whole background crawl finishes.
          redisPublishedByEntry.set(
            entryId,
            await writeRows(redis, season.seasonCode, eventId, scope, [row]),
          );
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
    if (completedBatch.length === 0) continue;

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
    const checkpointPublished = await managerScoreCheckpointRepository
      .upsertBatch(
        season,
        eventId,
        scope,
        completedBatch.map((row) => toManagerScoreCheckpoint(row)),
      )
      .then(() => true)
      .catch((error) => {
        logWarn('Official manager checkpoint write failed', {
          eventId,
          scope: scopeKey(scope),
          error: error instanceof Error ? error.message : 'unknown',
        });
        return false;
      });
    if (!checkpointPublished) {
      const undurableEntryIds = completedBatch
        .filter((row) => redisPublishedByEntry.get(row.entryId) !== true)
        .map((row) => row.entryId);
      for (const entryId of undurableEntryIds) {
        const previous = previousBatchRows.get(entryId);
        if (previous) rows.set(entryId, previous);
        else rows.delete(entryId);
      }
      if (undurableEntryIds.length > 0) {
        refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
        logWarn('Official manager summaries had no durable publication', {
          eventId,
          scope: scopeKey(scope),
          entryCount: undurableEntryIds.length,
        });
      }
    }
  }
  return refreshErrorCode;
};

export const refreshClassicStandings = async (
  season: FplSeasonRef,
  eventId: number,
  leagueId: number,
  targetIds: ReadonlySet<number>,
  rows: Map<number, CachedRow>,
  redis: Redis | null,
  options: { startPage?: number; maxPages?: number; requestDeadlineMs?: number } = {},
): Promise<{
  complete: boolean;
  nextPage: number;
  errorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null;
}> => {
  const checkedAt = nowIso();
  const fetchedRows: CachedRow[] = [];
  const previousRows = new Map<number, CachedRow | undefined>();
  let found = 0;
  const startPage = options.startPage ?? 1;
  const maxPages = options.maxPages ?? MAX_FOREGROUND_STANDINGS_PAGES;
  let nextPage = startPage;
  let exhausted = false;
  let refreshErrorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null = null;
  try {
    for (
      let page = startPage;
      page <= MANAGER_LIVE_CLASSIC_MAX_PAGE &&
      page < startPage + maxPages &&
      found < targetIds.size;
      page += 1
    ) {
      const response = await fplClient.getLeagueClassicStandings(
        leagueId,
        page,
        1,
        options.requestDeadlineMs === undefined
          ? undefined
          : { deadlineMs: options.requestDeadlineMs },
      );
      const pageRows = toClassicRows(season.seasonCode, eventId, response, checkedAt);
      for (const row of pageRows) {
        if (!targetIds.has(row.entryId)) continue;
        const existing = rows.get(row.entryId);
        if (!previousRows.has(row.entryId)) previousRows.set(row.entryId, existing);
        if (!existing || !isFresh(existing)) found += 1;
        const publishedRow = preserveClassicOverallRank(row, existing);
        fetchedRows.push(publishedRow);
        rows.set(publishedRow.entryId, publishedRow);
      }
      // Advance only after the page was fetched and processed successfully.
      // A 429/network failure must retry the failed page, not skip it forever.
      nextPage = page + 1;
      if (!response.standings.has_next) {
        exhausted = true;
        break;
      }
    }
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
  // Persist every page that completed before a later page failed. Advancing
  // the cursor without these writes would make the successful pages vanish
  // from the next worker run even though it correctly retries the failed page.
  const redisPublished = await writeRows(
    redis,
    season.seasonCode,
    eventId,
    { scopeType: 'CLASSIC_LEAGUE', scopeId: leagueId },
    fetchedRows,
    fetchedRows.length > 0
      ? {
          season: season.seasonCode,
          eventId,
          source: 'FPL_CLASSIC_STANDINGS',
          leagueId,
          rowCount: fetchedRows.length,
          checkedAt,
          revision: fetchedRows[0]?.revision ?? null,
          nextRefreshAt: new Date(Date.now() + REFRESH_SECONDS * 1000).toISOString(),
        }
      : undefined,
    `classic:${leagueId}:pages:${startPage}-${Math.max(startPage, nextPage - 1)}`,
  );
  const checkpointPublished =
    fetchedRows.length === 0
      ? true
      : await managerScoreCheckpointRepository
          .upsertBatch(
            season,
            eventId,
            { scopeType: 'CLASSIC_LEAGUE', scopeId: leagueId },
            fetchedRows.map((row) => toManagerScoreCheckpoint(row)),
          )
          .then(() => true)
          .catch((error) => {
            logWarn('Official manager checkpoint write failed', {
              eventId,
              leagueId,
              error: error instanceof Error ? error.message : 'unknown',
            });
            return false;
          });
  const durablyPublished = fetchedRows.length === 0 || redisPublished || checkpointPublished;
  if (!durablyPublished) {
    // The queue cursor is itself durable. Never let it skip rows that exist
    // only in this process after both publication stores rejected the page.
    for (const [entryId, previous] of previousRows) {
      if (previous) rows.set(entryId, previous);
      else rows.delete(entryId);
    }
    nextPage = startPage;
    refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
    logWarn('Official classic standings page had no durable publication', {
      eventId,
      leagueId,
      startPage,
      fetched: fetchedRows.length,
    });
  }
  logDebug('Official classic manager live refresh completed', {
    eventId,
    leagueId,
    requested: targetIds.size,
    fetched: fetchedRows.length,
    errorCode: refreshErrorCode,
  });
  return {
    complete:
      refreshErrorCode === null &&
      (exhausted || found >= targetIds.size || nextPage > MANAGER_LIVE_CLASSIC_MAX_PAGE),
    nextPage,
    errorCode: refreshErrorCode,
  };
};

export const classicStandingsCursorAfterRefresh = (
  completeRefresh: boolean,
  standings: Pick<Awaited<ReturnType<typeof refreshClassicStandings>>, 'complete' | 'nextPage'>,
): number | null | undefined =>
  completeRefresh ? (standings.complete ? null : standings.nextPage) : undefined;

const classicStandingNeedsOverallRank = (
  row: Pick<CachedRow, 'source' | 'overallRank'> | undefined,
): boolean =>
  row?.source === 'FPL_CLASSIC_STANDINGS' &&
  (typeof row.overallRank !== 'number' ||
    !Number.isSafeInteger(row.overallRank) ||
    row.overallRank <= 0);

export const selectWorkerSummaryRefreshTargets = (
  entryIds: readonly number[],
  limit: number,
  rotationBucket: number,
): number[] => {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const normalized = Array.from(new Set(entryIds));
  if (normalized.length <= limit) return normalized;
  const chunkCount = Math.ceil(normalized.length / limit);
  const bucket = Number.isSafeInteger(rotationBucket) ? Math.max(0, rotationBucket) : 0;
  const start = (bucket % chunkCount) * limit;
  return normalized.slice(start, start + limit);
};

export const selectClassicOverallRankRefreshTargets = (
  entryIds: readonly number[],
  rows: ReadonlyMap<number, Pick<CachedRow, 'source' | 'overallRank'>>,
  limit: number,
  rotationBucket: number,
): number[] => {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const normalized = Array.from(new Set(entryIds)).sort((left, right) => left - right);
  const missing = normalized.filter((entryId) =>
    classicStandingNeedsOverallRank(rows.get(entryId)),
  );
  const enriched = normalized.filter((entryId) => {
    const row = rows.get(entryId);
    return (
      row?.source === 'FPL_CLASSIC_STANDINGS' &&
      typeof row.overallRank === 'number' &&
      Number.isSafeInteger(row.overallRank) &&
      row.overallRank > 0
    );
  });
  const bucket = Number.isSafeInteger(rotationBucket) ? Math.max(0, rotationBucket) : 0;

  const rotatedTake = (values: readonly number[], count: number): number[] => {
    if (values.length === 0 || count <= 0) return [];
    const take = Math.min(values.length, count);
    const start = ((bucket % values.length) * take) % values.length;
    return Array.from({ length: take }, (_, offset) => values[(start + offset) % values.length]!);
  };

  // Missing OR remains the priority, but permanently failing entries must not
  // freeze every already-enriched manager forever. Reserve one slot for the
  // positive-OR rotation whenever both sets exist, and rotate both sets by the
  // 30-second worker bucket so every manager is eventually revisited.
  const missingLimit = enriched.length > 0 ? Math.max(1, limit - 1) : limit;
  const selected = rotatedTake(missing, missingLimit);
  selected.push(...rotatedTake(enriched, limit - selected.length));
  return selected;
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
        revisionAt: checkedAt,
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
  readMode?: ManagerLiveReadMode;
  completeRefresh?: boolean;
  classicStandingsStartPage?: number;
  summaryRotationBucket?: number;
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
    const sourceByEntry = new Map<number, ManagerLiveRowBacking>(
      rows.map((row) => [row.entryId, 'POSTGRES']),
    );
    return buildManagerLiveResult({
      season: season.seasonCode,
      eventId: input.eventId,
      rows,
      missingEntryIds: uniqueEntryIds.filter((entryId) => !resolvedWithFallbackIds.has(entryId)),
      errorCode: null,
      checkedAt: nowIso(),
      nextRefreshAt: nextRefresh(true),
      sourceByEntry,
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
  let rows = new Map<number, CachedRow>();
  const sourceByEntry = new Map<number, ManagerLiveRowBacking>();
  try {
    rows = await readCachedRows(redis, season.seasonCode, input.eventId, scope, uniqueEntryIds);
    for (const entryId of rows.keys()) sourceByEntry.set(entryId, 'REDIS');
  } catch (error) {
    logWarn('Official manager Redis read failed; using PostgreSQL checkpoint', {
      eventId: input.eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
  const checkpoints = await managerScoreCheckpointRepository
    .findByScopeAndEntryIds(season, input.eventId, scope, uniqueEntryIds)
    .catch((error) => {
      logWarn('Official manager PostgreSQL checkpoint read failed', {
        eventId: input.eventId,
        scope: scopeKey(scope),
        error: error instanceof Error ? error.message : 'unknown',
      });
      return [];
    });
  for (const checkpoint of checkpoints) {
    const cached = rows.get(checkpoint.entryId);
    const checkpointTime = checkpoint.checkedAt.getTime();
    const cachedTime = cached ? Date.parse(cached.checkedAt) : Number.NaN;
    const checkpointRevisionTime =
      checkpoint.updatedAt instanceof Date && Number.isFinite(checkpoint.updatedAt.getTime())
        ? checkpoint.updatedAt.getTime()
        : checkpointTime;
    const cachedRevisionTime = cached ? Date.parse(cached.revisionAt) : Number.NaN;
    const durableCheckpointWins =
      !cached ||
      !Number.isFinite(cachedTime) ||
      (Number.isFinite(checkpointTime) &&
        (checkpointTime > cachedTime ||
          (checkpointTime === cachedTime &&
            (!Number.isFinite(cachedRevisionTime) ||
              checkpointRevisionTime > cachedRevisionTime ||
              (checkpointRevisionTime === cachedRevisionTime &&
                checkpoint.contentRevision !== cached.revision)))));
    if (durableCheckpointWins) {
      rows.set(checkpoint.entryId, fromManagerScoreCheckpoint(checkpoint, season.seasonCode));
      sourceByEntry.set(checkpoint.entryId, 'POSTGRES');
    }
  }
  // Fill true gaps before refreshing last-good rows. Within stale rows, oldest
  // first prevents a bounded worker from repeatedly refreshing the same prefix
  // of a large tournament while later entries starve.
  const staleOrMissing = [
    ...uniqueEntryIds.filter((entryId) => !rows.has(entryId)),
    ...uniqueEntryIds
      .filter((entryId) => rows.has(entryId) && !isFresh(rows.get(entryId)!))
      .sort(
        (left, right) =>
          Date.parse(rows.get(left)!.checkedAt) - Date.parse(rows.get(right)!.checkedAt),
      ),
  ];
  const classicOverallRankMissing =
    input.tournamentId !== undefined &&
    tournament?.leagueType === 'classic' &&
    uniqueEntryIds.some((entryId) => classicStandingNeedsOverallRank(rows.get(entryId)));
  let errorCode: ManagerLiveResolveResult['errorCode'] = null;
  let refreshErrorCode: Exclude<
    ManagerLiveResolveResult['errorCode'],
    'UNSUPPORTED_H2H_LIVE' | null
  > | null = null;
  let classicStandingsNextPage: number | null | undefined;

  if ((input.readMode ?? 'READ_THROUGH') === 'CACHE_ONLY') {
    const now = Date.now();
    const resolvedRows = uniqueEntryIds
      .map((entryId) => rows.get(entryId))
      .filter((row): row is CachedRow => row !== undefined && isWithinStaleWindow(row, now));
    const resolvedIds = new Set(resolvedRows.map((row) => row.entryId));
    const missingEntryIds = uniqueEntryIds.filter((entryId) => !resolvedIds.has(entryId));
    let refreshQueued = false;
    try {
      await dispatchManagerLiveRefreshBounded({
        season,
        eventId: input.eventId,
        entryIds: uniqueEntryIds,
        ...(input.tournamentId === undefined ? {} : { tournamentId: input.tournamentId }),
      });
      refreshQueued = true;
    } catch (error) {
      logWarn('Manager live cache-only response could not queue a refresh', {
        eventId: input.eventId,
        tournamentId: input.tournamentId ?? null,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    return buildManagerLiveResult({
      season: season.seasonCode,
      eventId: input.eventId,
      rows: resolvedRows,
      missingEntryIds,
      errorCode: missingEntryIds.length > 0 ? 'UPSTREAM_UNAVAILABLE' : null,
      nextRefreshAt: nextRefresh(event.finished),
      sourceByEntry,
      refreshQueued,
    });
  }

  const initialRevisionByEntry = new Map(
    [...rows].map(([entryId, row]) => [entryId, `${row.revision}:${row.checkedAt}`] as const),
  );
  const completeRefresh = input.completeRefresh === true;
  let workerSummaryBudget = completeRefresh ? MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT : 0;
  const workerRotationBucket =
    completeRefresh && Number.isSafeInteger(input.summaryRotationBucket)
      ? Math.max(0, input.summaryRotationBucket ?? 0)
      : Math.floor(Date.now() / MANAGER_LIVE_REFRESH_BUCKET_MS);
  const takeWorkerSummaryTargets = (entryIds: readonly number[], limit = workerSummaryBudget) => {
    if (!completeRefresh) return [...entryIds];
    const selected = selectWorkerSummaryRefreshTargets(
      entryIds,
      Math.min(workerSummaryBudget, limit),
      workerRotationBucket,
    );
    workerSummaryBudget -= selected.length;
    return selected;
  };
  const workerRequestDeadlineMs = completeRefresh
    ? MANAGER_LIVE_WORKER_REQUEST_DEADLINE_MS
    : undefined;

  if (input.tournamentId !== undefined && tournament?.leagueType === 'h2h') {
    // FPL does not expose a live H2H table, but its official entry summary is
    // still a well-defined event score. Use it for provisional pairings and
    // let the final database result replace it after finalization.
    if (staleOrMissing.length > 0) {
      const summaryTargets = completeRefresh
        ? takeWorkerSummaryTargets(staleOrMissing)
        : staleOrMissing;
      refreshErrorCode = await refreshEntrySummaries(
        season,
        input.eventId,
        summaryTargets,
        rows,
        redis,
        entryScope,
        {
          maxFetches: completeRefresh ? undefined : MAX_FOREGROUND_SUMMARY_FETCHES,
          requestDeadlineMs: workerRequestDeadlineMs,
        },
      );
      const pending = staleOrMissing.filter(
        (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
      );
      if (!completeRefresh && pending.length > 0) {
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
    (completeRefresh || staleOrMissing.length > 0 || classicOverallRankMissing)
  ) {
    if (!tournament) throw new Error('Tournament validation unexpectedly missing');
    const classicLeagueId = tournament.leagueId;
    const classicStandingsStartPage =
      completeRefresh &&
      Number.isSafeInteger(input.classicStandingsStartPage) &&
      (input.classicStandingsStartPage ?? 0) >= 1 &&
      (input.classicStandingsStartPage ?? 0) <= MANAGER_LIVE_CLASSIC_MAX_PAGE
        ? input.classicStandingsStartPage
        : 1;
    const standings = await refreshClassicStandings(
      season,
      input.eventId,
      classicLeagueId,
      new Set(staleOrMissing),
      rows,
      redis,
      completeRefresh
        ? {
            startPage: classicStandingsStartPage,
            maxPages: MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT,
            requestDeadlineMs: workerRequestDeadlineMs,
          }
        : undefined,
    );
    refreshErrorCode = standings.errorCode;
    if (completeRefresh) {
      // `null` is an explicit completion marker in queue Redis. Write it even
      // when another overlapping refresh made every standings target fresh;
      // otherwise a stale later-page cursor can be revived after those rows
      // age again.
      classicStandingsNextPage = classicStandingsCursorAfterRefresh(completeRefresh, standings);
    }

    // FPL classic standings expose the event/phase totals and the league
    // position, but not the season-wide Overall Rank (OR). Do not let the
    // GraphQL layer fall back to the stale rank captured when the manager
    // joined the tournament. Enrich the classic row with the current entry
    // summary rank while preserving its classic standings metrics.
    const classicOverallRankTargets = completeRefresh
      ? selectClassicOverallRankRefreshTargets(
          uniqueEntryIds,
          rows,
          MANAGER_LIVE_WORKER_CLASSIC_OR_FETCH_LIMIT,
          Math.floor(Date.now() / MANAGER_LIVE_REFRESH_BUCKET_MS),
        )
      : uniqueEntryIds.filter((entryId) => classicStandingNeedsOverallRank(rows.get(entryId)));
    if (classicOverallRankTargets.length > 0) {
      const foregroundTargets = completeRefresh
        ? takeWorkerSummaryTargets(
            classicOverallRankTargets,
            MANAGER_LIVE_WORKER_CLASSIC_OR_FETCH_LIMIT,
          )
        : classicOverallRankTargets.slice(0, MAX_FOREGROUND_OVERALL_RANK_FETCHES);
      const summaryError = await refreshEntrySummaries(
        season,
        input.eventId,
        foregroundTargets,
        rows,
        redis,
        scope,
        {
          force: true,
          preserveClassicStanding: true,
          requestDeadlineMs: workerRequestDeadlineMs,
        },
      );
      refreshErrorCode = refreshErrorCode ?? summaryError;

      const pendingOverallRank = classicOverallRankTargets.filter((entryId) =>
        classicStandingNeedsOverallRank(rows.get(entryId)),
      );
      if (!completeRefresh && pendingOverallRank.length > 0) {
        const backgroundKey = `classic-or:${season.seasonCode}:${input.eventId}:${classicLeagueId}`;
        scheduleBackgroundRefresh(backgroundKey, async () => {
          const backgroundRows = await readCachedRows(
            redis,
            season.seasonCode,
            input.eventId,
            scope,
            pendingOverallRank,
          );
          await refreshEntrySummaries(
            season,
            input.eventId,
            pendingOverallRank,
            backgroundRows,
            redis,
            scope,
            { force: true, priority: 'background', preserveClassicStanding: true },
          );
        });
      }
    }

    let pending = staleOrMissing.filter(
      (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
    );
    const workerFallbackTargets = selectWorkerClassicFallbackTargets(
      pending,
      rows,
      standings.complete,
    );
    const fallbackPlan = completeRefresh
      ? {
          foregroundSummaryEntryIds: takeWorkerSummaryTargets(workerFallbackTargets),
          backgroundEntryIds: [] as number[],
          continueStandings: false,
        }
      : planClassicManagerFallback(pending, standings.complete);
    if (fallbackPlan.foregroundSummaryEntryIds.length > 0) {
      const summaryError = await refreshEntrySummaries(
        season,
        input.eventId,
        fallbackPlan.foregroundSummaryEntryIds,
        rows,
        redis,
        scope,
        { requestDeadlineMs: workerRequestDeadlineMs },
      );
      refreshErrorCode = refreshErrorCode ?? summaryError;
      pending = fallbackPlan.backgroundEntryIds.filter(
        (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
      );
    }
    if (!completeRefresh && pending.length > 0) {
      const backgroundKey = `classic:${season.seasonCode}:${input.eventId}:${classicLeagueId}`;
      scheduleBackgroundRefresh(backgroundKey, async () => {
        const backgroundRows = await readCachedRows(
          redis,
          season.seasonCode,
          input.eventId,
          scope,
          pending,
        );
        const backgroundResult = fallbackPlan.continueStandings
          ? await refreshClassicStandings(
              season,
              input.eventId,
              classicLeagueId,
              new Set(pending),
              backgroundRows,
              redis,
              { startPage: standings.nextPage, maxPages: MANAGER_LIVE_CLASSIC_MAX_PAGE },
            )
          : { complete: true, nextPage: standings.nextPage, errorCode: null };
        const summaryTargets = pending.filter(
          (entryId) => !backgroundRows.has(entryId) || !isFresh(backgroundRows.get(entryId)!),
        );
        if (backgroundResult.complete && summaryTargets.length > 0) {
          await refreshEntrySummaries(
            season,
            input.eventId,
            summaryTargets,
            backgroundRows,
            redis,
            scope,
            { priority: 'background' },
          );
        }
        logDebug('Official classic manager background refresh completed', {
          eventId: input.eventId,
          leagueId: classicLeagueId,
          remaining: summaryTargets.length,
          complete: backgroundResult.complete,
        });
      });
    }
  }

  if (input.tournamentId === undefined && staleOrMissing.length > 0) {
    const summaryTargets = completeRefresh
      ? takeWorkerSummaryTargets(staleOrMissing)
      : staleOrMissing;
    refreshErrorCode = await refreshEntrySummaries(
      season,
      input.eventId,
      summaryTargets,
      rows,
      redis,
      entryScope,
      {
        maxFetches: completeRefresh ? undefined : MAX_FOREGROUND_SUMMARY_FETCHES,
        requestDeadlineMs: workerRequestDeadlineMs,
      },
    );
    const pending = summaryTargets.filter(
      (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
    );
    if (!completeRefresh && pending.length > 0) {
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
  for (const row of resolvedRows) {
    if (initialRevisionByEntry.get(row.entryId) !== `${row.revision}:${row.checkedAt}`) {
      sourceByEntry.set(row.entryId, 'UPSTREAM');
    }
  }
  if (!errorCode && refreshErrorCode) errorCode = refreshErrorCode;
  // A bounded worker may intentionally leave entries for the next hot-scope
  // bucket. That is progress, not an upstream failure. Request-path reads and
  // actual FPL failures retain the existing error semantics.
  if (!errorCode && missingEntryIds.length > 0 && !completeRefresh) {
    errorCode = 'UPSTREAM_UNAVAILABLE';
  }

  return buildManagerLiveResult({
    season: season.seasonCode,
    eventId: input.eventId,
    rows: resolvedRows,
    missingEntryIds,
    errorCode,
    nextRefreshAt: nextRefresh(event.finished),
    sourceByEntry,
    classicStandingsNextPage,
  });
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
  readMode?: ManagerLiveReadMode;
}): Promise<ManagerLiveResolveResult> {
  const key = JSON.stringify({
    eventId: input.eventId,
    entryIds: Array.from(new Set(input.entryIds)).sort((a, b) => a - b),
    tournamentId: input.tournamentId ?? null,
    readMode: input.readMode ?? 'READ_THROUGH',
  });
  const existing = managerLiveInFlight.get(key);
  if (existing) return existing;
  const promise = resolveManagerLiveScoresUncoalesced(input).finally(() => {
    managerLiveInFlight.delete(key);
  });
  managerLiveInFlight.set(key, promise);
  return promise;
}

export async function refreshManagerLiveScores(input: {
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
  classicStandingsStartPage?: number;
  summaryRotationBucket?: number;
}): Promise<ManagerLiveResolveResult> {
  const key = JSON.stringify({
    eventId: input.eventId,
    entryIds: Array.from(new Set(input.entryIds)).sort((left, right) => left - right),
    tournamentId: input.tournamentId ?? null,
    classicStandingsStartPage: input.classicStandingsStartPage ?? null,
    summaryRotationBucket: input.summaryRotationBucket ?? null,
    readMode: 'READ_THROUGH',
    completeRefresh: true,
  });
  const existing = managerLiveInFlight.get(key);
  if (existing) return existing;
  const promise = resolveManagerLiveScoresUncoalesced({
    ...input,
    readMode: 'READ_THROUGH',
    completeRefresh: true,
  }).finally(() => {
    managerLiveInFlight.delete(key);
  });
  managerLiveInFlight.set(key, promise);
  return promise;
}
