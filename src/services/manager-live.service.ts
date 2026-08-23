import { createHash } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import type Redis from 'ioredis';
import type postgres from 'postgres';

import { fplClient, type RawFPLLeagueStandingsResponse } from '../clients/fpl';
import { publishManagerLiveCacheMonotonically } from '../cache/manager-live-publication';
import { redisSingleton } from '../cache/singleton';
import { getDbClient, runInDatabaseTransaction } from '../db/singleton';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import * as databaseSchema from '../db/schemas/index.schema';
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
  createKeyedSerialTaskScheduler,
  createManagerSummaryFetchGate,
  isPositiveOverallRank,
  isNewerClassicOverallRankPublicationOrder,
  managerSummaryFetchBatches,
  mergeUniqueTargetManagerRows,
  pendingOverallRankRefreshEntryIds,
  type ManagerSummaryFetchPriority,
  planClassicManagerFallback,
  planClassicOverallRankRefresh,
  preserveLastKnownOverallRank,
  reconcileMonotonicCachePublicationRows,
  selectClassicSummaryOverallRank,
  selectLatestCheckedRow,
  shouldPreserveClassicStandingForRank,
  shouldRefreshClassicOverallRank,
  shouldRetryPendingClassicOverallRank,
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
const cacheOrderKey = (season: string, eventId: number, scope: ManagerScoreScope): string =>
  `OfficialManagerLiveOrder:${season}:${eventId}:${scopeKey(scope)}`;
const overallRankMarkerCacheKey = (
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
): string => `OfficialManagerOverallRankMarker:${season}:${eventId}:${scopeKey(scope)}`;

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

const withOverallRank = (
  row: ManagerLiveScoreRow,
  overallRank: number | null,
): ManagerLiveScoreRow => {
  if (overallRank === row.overallRank) return row;

  const { revision: _revision, ...withoutRevision } = row;
  return withRevision({ ...withoutRevision, overallRank });
};

const withPreservedOverallRank = (
  row: ManagerLiveScoreRow,
  previousOverallRank: number | null | undefined,
): ManagerLiveScoreRow => {
  const overallRank = preserveLastKnownOverallRank(row.overallRank, previousOverallRank);
  return withOverallRank(row, overallRank);
};

const mergeLatestManagerLiveRow = (
  current: CachedRow | undefined,
  candidate: CachedRow,
): CachedRow => {
  const latest = selectLatestCheckedRow(current, candidate);
  const other = latest === candidate ? current : candidate;
  return withPreservedOverallRank(latest, other?.overallRank);
};

const toManagerScoreCheckpoint = (
  row: ManagerLiveScoreRow,
  overallRankPublicationStartedAt?: string | null,
): ManagerScoreCheckpoint => ({
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
  overallRankPublicationStartedAt,
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

const readCachedRowsForPublication = async (
  redis: Redis | null,
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
  entryIds: readonly number[],
): Promise<Map<number, CachedRow>> => {
  try {
    return await readCachedRows(redis, season, eventId, scope, entryIds);
  } catch (error) {
    logWarn('Official manager Redis read failed before Classic publication', {
      eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
    return new Map();
  }
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
    const cachedOrSeedRow = rows.get(checkpoint.entryId);
    rows.set(
      checkpoint.entryId,
      cachedOrSeedRow ? mergeLatestManagerLiveRow(checkpointRow, cachedOrSeedRow) : checkpointRow,
    );
  }
  return rows;
};

const readClassicPublicationState = async (
  season: FplSeasonRef,
  eventId: number,
  scope: ManagerScoreScope,
  entryIds: readonly number[],
  seedRows?: ReadonlyMap<number, CachedRow>,
  cachedRows?: ReadonlyMap<number, CachedRow>,
): Promise<{
  rows: Map<number, CachedRow>;
  overallRankPublicationStartedAtByEntryId: Map<number, string>;
}> => {
  const wantedEntryIds = new Set(entryIds);
  const rows = new Map<number, CachedRow>();
  for (const [entryId, row] of seedRows ?? []) {
    if (wantedEntryIds.has(entryId)) rows.set(entryId, row);
  }

  for (const [entryId, row] of cachedRows ?? []) {
    if (wantedEntryIds.has(entryId)) {
      rows.set(entryId, mergeLatestManagerLiveRow(rows.get(entryId), row));
    }
  }

  // Publication cannot safely continue without the durable OR ordering
  // evidence. Unlike request-path reads, let this error abort the transaction.
  const checkpoints = await managerScoreCheckpointRepository.findByScopeAndEntryIds(
    season,
    eventId,
    scope,
    entryIds,
  );
  const overallRankPublicationStartedAtByEntryId = new Map<number, string>();
  for (const checkpoint of checkpoints) {
    const checkpointRow = fromManagerScoreCheckpoint(checkpoint, season.seasonCode);
    const cachedOrSeedRow = rows.get(checkpoint.entryId);
    rows.set(
      checkpoint.entryId,
      cachedOrSeedRow ? mergeLatestManagerLiveRow(checkpointRow, cachedOrSeedRow) : checkpointRow,
    );
    overallRankPublicationStartedAtByEntryId.set(
      checkpoint.entryId,
      checkpoint.overallRankPublicationStartedAtExact,
    );
  }
  return { rows, overallRankPublicationStartedAtByEntryId };
};

const writeRows = async (
  redis: Redis | null,
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
  rows: readonly ManagerLiveScoreRow[],
  metadata?: Record<string, unknown>,
  metadataField = 'publication',
): Promise<boolean> => {
  if (!redis) return false;
  if (rows.length === 0 && !metadata) return true;
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
    if (results === null || results.some(([error]) => error !== null)) {
      throw new Error('Redis manager publication transaction failed');
    }
    return true;
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

const writeClassicRowsMonotonically = async (
  redis: Redis | null,
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
  rows: readonly ManagerLiveScoreRow[],
  metadata: Record<string, unknown>,
  metadataField: string,
  publicationOrder: string,
  overallRankPublicationOrders: ReadonlyMap<number, string>,
): Promise<readonly number[] | null> => {
  if (!redis) return null;
  try {
    return await publishManagerLiveCacheMonotonically(redis, {
      rowKey: cacheKey(season, eventId, scope),
      metadataKey: metaCacheKey(season, eventId, scope),
      rowOrderKey: cacheOrderKey(season, eventId, scope),
      overallRankMarkerKey: overallRankMarkerCacheKey(season, eventId, scope),
      publicationOrder,
      rows: rows.map((row) => ({
        entryId: row.entryId,
        payload: JSON.stringify(row),
        overallRankPublicationOrder: isPositiveOverallRank(row.overallRank)
          ? (overallRankPublicationOrders.get(row.entryId) ?? null)
          : null,
      })),
      metadataField,
      metadataPayload: JSON.stringify(metadata),
      ttlSeconds: CACHE_TTL_SECONDS,
    });
  } catch (error) {
    logWarn('Official manager monotonic Redis write failed; PostgreSQL remains authoritative', {
      season,
      eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
};

const reconcileClassicRowsAfterCachePublication = async (
  redis: Redis | null,
  season: FplSeasonRef,
  eventId: number,
  scope: ManagerScoreScope,
  publishedRows: readonly ManagerLiveScoreRow[],
  cacheUpdatedEntryIds: readonly number[] | null,
): Promise<ManagerLiveScoreRow[]> => {
  if (cacheUpdatedEntryIds === null || cacheUpdatedEntryIds.length === publishedRows.length) {
    return [...publishedRows];
  }

  const cacheUpdated = new Set(cacheUpdatedEntryIds);
  const rejectedEntryIds = publishedRows
    .map((row) => row.entryId)
    .filter((entryId) => !cacheUpdated.has(entryId));
  const authoritativeRejectedRows = await readCachedAndCheckpointRows(
    redis,
    season,
    eventId,
    scope,
    rejectedEntryIds,
  );
  return reconcileMonotonicCachePublicationRows(
    publishedRows,
    cacheUpdatedEntryIds,
    authoritativeRejectedRows,
  );
};

const writeCheckpointRows = async (
  season: FplSeasonRef,
  eventId: number,
  scope: ManagerScoreScope,
  rows: readonly ManagerLiveScoreRow[],
  overallRankPublicationStartedAtByEntryId: ReadonlyMap<number, string> = new Map(),
): Promise<boolean> => {
  try {
    await managerScoreCheckpointRepository.upsertBatch(
      season,
      eventId,
      scope,
      rows.map((row) =>
        toManagerScoreCheckpoint(
          row,
          overallRankPublicationStartedAtByEntryId.get(row.entryId) ?? null,
        ),
      ),
    );
    return true;
  } catch (error) {
    logWarn('Official manager checkpoint write failed', {
      eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
};

const readOverallRankRefreshMarkers = async (
  redis: Redis | null,
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
  entryIds: readonly number[],
): Promise<Map<number, string> | null> => {
  if (!redis) return null;
  const uniqueEntryIds = Array.from(new Set(entryIds));
  if (uniqueEntryIds.length === 0) return new Map();
  try {
    const values = await redis.hmget(
      overallRankMarkerCacheKey(season, eventId, scope),
      ...uniqueEntryIds.map(String),
    );
    const markers = new Map<number, string>();
    uniqueEntryIds.forEach((entryId, index) => {
      const marker = values[index];
      if (marker) markers.set(entryId, marker);
    });
    return markers;
  } catch (error) {
    logWarn('Official manager overall-rank marker read failed', {
      eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
    return null;
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

const runManagerLiveBackgroundRefresh = createKeyedSerialTaskScheduler();
// This gate is shared by every live-desk refresh in the process. Per-request
// batching alone is insufficient because distinct tournaments can refresh at
// the same time and otherwise multiply FPL entry-summary concurrency.
const runManagerSummaryFetch = createManagerSummaryFetchGate();
// Cross-replica publication uses a short PostgreSQL transaction advisory lock.
// External FPL calls happen between a brief ordering reservation and this
// reconciliation lock, so a slow upstream never occupies the database pool.
const runManagerLivePublicationInProcess = createKeyedSerialTaskGate();
const runManagerLivePublication = <T>(
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> =>
  runManagerLivePublicationInProcess(
    key,
    async (): Promise<T> => {
      if (signal?.aborted) throw signal.reason;
      const client = await getDbClient();
      return (await client.begin(async (transaction) => {
        if (signal?.aborted) throw signal.reason;
        const lockQuery = transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`manager-live:${key}`}, 0))`;
        const cancelLock = (): void => lockQuery.cancel();
        signal?.addEventListener('abort', cancelLock, { once: true });
        try {
          await lockQuery;
        } finally {
          signal?.removeEventListener('abort', cancelLock);
        }
        if (signal?.aborted) throw signal.reason;
        const lockedDb = drizzle(transaction as unknown as postgres.Sql, {
          schema: databaseSchema,
        });
        return runInDatabaseTransaction(transaction, task, lockedDb);
      })) as T;
    },
    signal,
  );
const reserveManagerLivePublicationStartedAt = (
  key: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof readDatabaseOrderingTimestamp>>> =>
  runManagerLivePublication(key, () => readDatabaseOrderingTimestamp(), signal);
const managerLivePublicationKey = (
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
): string => `${season}:${eventId}:${scopeKey(scope)}`;

const scheduleBackgroundRefresh = (
  serialKey: string,
  workKey: string,
  task: () => Promise<void>,
): void => {
  void runManagerLiveBackgroundRefresh(serialKey, workKey, task).catch((error) => {
    logWarn('Official manager live background refresh failed', {
      key: serialKey,
      workKey,
      error: error instanceof FPLClientError ? (error.code ?? error.status) : 'unknown',
    });
  });
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
    let fallbackBaselineRows: Map<number, CachedRow | null> | null = null;
    if (classicScope && options.preserveClassicStanding !== true) {
      try {
        // Define fallback start with a successful durable read under the same
        // scope lock used by publishers. A null row now means confirmed absent,
        // never "unknown because the request-path checkpoint read failed".
        const baselineState = await runManagerLivePublication(publicationKey, () =>
          readClassicPublicationState(season, eventId, scope, batch, rows),
        );
        fallbackBaselineRows = new Map(
          batch.map((entryId) => [entryId, baselineState.rows.get(entryId) ?? null] as const),
        );
      } catch (error) {
        refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
        logWarn('Official manager fallback baseline read failed', {
          eventId,
          scope: scopeKey(scope),
          error: error instanceof Error ? error.message : 'unknown',
        });
        continue;
      }
    }
    const completed = await Promise.all(
      batch.map(async (entryId) => {
        try {
          const fetched = await runManagerSummaryFetch(async () => {
            let publicationOrder: string | null = null;
            // The FPL client invokes this hook after every retry backoff and
            // immediately before the corresponding fetch. The retained token
            // therefore belongs to the attempt that produced the response.
            const summary = classicScope
              ? await fplClient.getEntrySummary(entryId, {
                  beforeAttempt: async (_attempt, { signal }) => {
                    publicationOrder = (
                      await reserveManagerLivePublicationStartedAt(publicationKey, signal)
                    ).exact;
                  },
                })
              : await fplClient.getEntrySummary(entryId);
            return { summary, publicationOrder };
          }, options.priority);
          return { entryId, ...fetched };
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
          return null;
        }
      }),
    );
    const successful = completed.filter(
      (result): result is NonNullable<typeof result> => result !== null,
    );
    if (successful.length === 0) continue;
    const publicationCheckedAt = nowIso();
    const targetEntryIds = successful.map(({ entryId }) => entryId);
    const cachedPublicationRows = classicScope
      ? await readCachedRowsForPublication(redis, season.seasonCode, eventId, scope, targetEntryIds)
      : new Map<number, CachedRow>();

    const composeAndPublishBatch = async (
      reReadLatest: boolean,
    ): Promise<{
      rows: ManagerLiveScoreRow[];
      refreshedEntryIds: number[];
      overallRankRefreshedEntryIds: number[];
      cachePublicationOrder: string | null;
      overallRankPublicationOrders: Map<number, string>;
      metadata: Record<string, unknown>;
    }> => {
      const publicationState = reReadLatest
        ? await readClassicPublicationState(
            season,
            eventId,
            scope,
            targetEntryIds,
            rows,
            cachedPublicationRows,
          )
        : null;
      const latestRows = publicationState?.rows ?? rows;

      const batchRefreshedEntryIds: number[] = [];
      const batchOverallRankRefreshedEntryIds: number[] = [];
      const acceptedOverallRankPublicationOrders = new Map<number, string>();
      const overallRankPublicationOrders = new Map(
        publicationState?.overallRankPublicationStartedAtByEntryId ?? [],
      );
      const publishedRows = successful.map(
        ({ entryId, summary, publicationOrder: summaryPublicationOrder }) => {
          const existing = latestRows.get(entryId) ?? rows.get(entryId);
          // Every Classic publication re-reads the checkpoint. Explicit OR
          // enrichment always retains standings; fallback does so only when a
          // standing advanced after this Summary wave began.
          const candidate = shouldPreserveClassicStandingForRank(
            options.preserveClassicStanding,
            existing,
            reReadLatest && options.preserveClassicStanding !== true
              ? (fallbackBaselineRows?.get(entryId) ?? null)
              : undefined,
          )
            ? (() => {
                const { revision: _revision, ...classicRow } = existing;
                return withRevision({
                  ...classicRow,
                  // Classic standings owns event/phase totals and league rank;
                  // the entry summary owns the season-wide FPL OR.
                  overallRank: summary.summary_overall_rank ?? null,
                });
              })()
            : toEntrySummaryRow(season.seasonCode, eventId, entryId, summary, publicationCheckedAt);
          batchRefreshedEntryIds.push(entryId);
          if (isPositiveOverallRank(summary.summary_overall_rank)) {
            batchOverallRankRefreshedEntryIds.push(entryId);
          }
          const publicationOrderIsNewer =
            reReadLatest &&
            isNewerClassicOverallRankPublicationOrder(
              summaryPublicationOrder ?? '',
              publicationState?.overallRankPublicationStartedAtByEntryId.get(entryId),
            );
          const acceptOverallRank =
            publicationOrderIsNewer && isPositiveOverallRank(summary.summary_overall_rank);
          const orderedCandidate = reReadLatest
            ? withOverallRank(
                candidate,
                selectClassicSummaryOverallRank(
                  candidate.overallRank,
                  existing?.overallRank,
                  acceptOverallRank,
                ),
              )
            : candidate;
          let merged = reReadLatest
            ? mergeLatestManagerLiveRow(existing, orderedCandidate)
            : withPreservedOverallRank(candidate, existing?.overallRank);
          if (
            acceptOverallRank &&
            isPositiveOverallRank(summary.summary_overall_rank) &&
            merged.overallRank !== summary.summary_overall_rank
          ) {
            const { revision: _revision, ...withoutRevision } = merged;
            merged = withRevision({
              ...withoutRevision,
              overallRank: summary.summary_overall_rank,
            });
          }
          if (acceptOverallRank && summaryPublicationOrder) {
            acceptedOverallRankPublicationOrders.set(entryId, summaryPublicationOrder);
            overallRankPublicationOrders.set(entryId, summaryPublicationOrder);
          }
          return merged;
        },
      );

      const metadata = {
        season: season.seasonCode,
        eventId,
        source: 'FPL_ENTRY_SUMMARY',
        rowCount: refreshed.length + publishedRows.length,
        checkedAt: publicationCheckedAt,
        revision: publishedRows[0]!.revision,
        nextRefreshAt: new Date(Date.now() + REFRESH_SECONDS * 1000).toISOString(),
      };
      if (classicScope) {
        const checkpointPublished = await writeCheckpointRows(
          season,
          eventId,
          scope,
          publishedRows,
          acceptedOverallRankPublicationOrders,
        );
        if (!checkpointPublished) {
          throw new Error('Classic entry-summary checkpoint publication failed');
        }
        const cachePublicationOrder = (await readDatabaseOrderingTimestamp()).exact;
        return {
          rows: publishedRows,
          refreshedEntryIds: batchRefreshedEntryIds,
          overallRankRefreshedEntryIds: batchOverallRankRefreshedEntryIds,
          cachePublicationOrder,
          overallRankPublicationOrders,
          metadata,
        };
      }

      await writeRows(
        redis,
        season.seasonCode,
        eventId,
        scope,
        publishedRows,
        metadata,
        'entry-summary',
      );
      return {
        rows: publishedRows,
        refreshedEntryIds: batchRefreshedEntryIds,
        overallRankRefreshedEntryIds: batchOverallRankRefreshedEntryIds,
        cachePublicationOrder: null,
        overallRankPublicationOrders,
        metadata,
      };
    };

    // Reconcile and publish only after FPL I/O has completed. The durable
    // positive-OR ordering marker rejects an earlier delayed response even if
    // a later valid fetch returned the unchanged rank or Redis is unavailable.
    let publishedBatch: Awaited<ReturnType<typeof composeAndPublishBatch>>;
    try {
      publishedBatch = classicScope
        ? await runManagerLivePublication(publicationKey, () => composeAndPublishBatch(true))
        : await composeAndPublishBatch(false);
    } catch (error) {
      refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
      logWarn('Official manager entry-summary publication failed', {
        eventId,
        scope: scopeKey(scope),
        error: error instanceof Error ? error.message : 'unknown',
      });
      continue;
    }
    if (!classicScope) await writeCheckpointRows(season, eventId, scope, publishedBatch.rows);
    let responseRows = publishedBatch.rows;
    if (classicScope) {
      const cacheUpdatedEntryIds = await writeClassicRowsMonotonically(
        redis,
        season.seasonCode,
        eventId,
        scope,
        publishedBatch.rows,
        publishedBatch.metadata,
        'entry-summary',
        publishedBatch.cachePublicationOrder!,
        publishedBatch.overallRankPublicationOrders,
      );
      responseRows = await reconcileClassicRowsAfterCachePublication(
        redis,
        season,
        eventId,
        scope,
        publishedBatch.rows,
        cacheUpdatedEntryIds,
      );
    }
    for (const row of responseRows) rows.set(row.entryId, row);
    refreshedEntryIds.push(...publishedBatch.refreshedEntryIds);
    overallRankRefreshedEntryIds.push(...publishedBatch.overallRankRefreshedEntryIds);
    refreshed.push(...responseRows);
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
  const crawlStartedAt = nowIso();
  let fetchedRows = new Map<number, ManagerLiveScoreRow>();
  const classicScope: ManagerScoreScope = { scopeType: 'CLASSIC_LEAGUE', scopeId: leagueId };
  const startPage = options.startPage ?? 1;
  const maxPages = options.maxPages ?? MAX_FOREGROUND_STANDINGS_PAGES;
  let nextPage = startPage;
  let exhausted = false;
  let refreshErrorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null = null;
  try {
    for (
      let page = startPage;
      page <= MAX_STANDINGS_PAGES &&
      page < startPage + maxPages &&
      fetchedRows.size < targetIds.size;
      page += 1
    ) {
      const response = await fplClient.getLeagueClassicStandings(leagueId, page);
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
  if (fetchedRows.size > 0) {
    try {
      const uniqueFetchedRows = Array.from(fetchedRows.values());
      const cachedPublicationRows = await readCachedRowsForPublication(
        redis,
        season.seasonCode,
        eventId,
        classicScope,
        uniqueFetchedRows.map((row) => row.entryId),
      );
      const publication = await runManagerLivePublication(
        managerLivePublicationKey(season.seasonCode, eventId, classicScope),
        async () => {
          // Network pagination happens outside the publication gate. Stamp the
          // rows only after the gate is acquired so a crawl that finishes after
          // an OR write is also ordered after that write during reconciliation.
          const publicationCheckedAt = nowIso();
          const publicationState = await readClassicPublicationState(
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
          const checkpointPublished = await writeCheckpointRows(
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
            cachePublicationOrder: (await readDatabaseOrderingTimestamp()).exact,
            overallRankPublicationOrders: publicationState.overallRankPublicationStartedAtByEntryId,
          };
        },
      );
      publishedRows = publication.rows;
      const cacheUpdatedEntryIds = await writeClassicRowsMonotonically(
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
      const responseRows = await reconcileClassicRowsAfterCachePublication(
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
      // No row can be reported refreshed unless its durable checkpoint write
      // completed. Restart pagination from this batch's first page so a later
      // retry cannot skip rows that existed only in process memory.
      nextPage = startPage;
      logWarn('Official classic manager standings publication failed', {
        eventId,
        leagueId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  logDebug('Official classic manager live refresh completed', {
    eventId,
    leagueId,
    requested: targetIds.size,
    fetched: fetchedRows.size,
    published: publishedRows.length,
    partial: refreshErrorCode !== null,
  });
  return {
    complete:
      refreshErrorCode === null &&
      (exhausted || fetchedRows.size >= targetIds.size || nextPage > MAX_STANDINGS_PAGES),
    nextPage,
    errorCode: refreshErrorCode,
    refreshedEntryIds: publishedRows.map((row) => row.entryId),
  };
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
        const backgroundKey = `h2h:${season.seasonCode}:${input.eventId}:${input.tournamentId}`;
        const backgroundWorkKey = `${backgroundKey}:entries:${pending
          .slice()
          .sort((left, right) => left - right)
          .join(',')}`;
        scheduleBackgroundRefresh(backgroundKey, backgroundWorkKey, async () => {
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
    // Capture OR-specific completion evidence before any work in this request.
    // A standings publication also advances checkedAt, so row timestamps cannot
    // distinguish deferred OR work from an OR refresh completed by another
    // request or replica while this background task waits for its turn.
    const overallRankMarkerBaseline = await readOverallRankRefreshMarkers(
      redis,
      season.seasonCode,
      input.eventId,
      scope,
      uniqueEntryIds,
    );
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
    const fallbackSummaryOverallRankRefreshedEntryIds = new Set<number>();
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
      for (const entryId of summaryRefresh.overallRankRefreshedEntryIds) {
        fallbackSummaryOverallRankRefreshedEntryIds.add(entryId);
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
        !fallbackSummaryOverallRankRefreshedEntryIds.has(entryId) &&
        shouldRefreshClassicOverallRank(rows.get(entryId), staleOrMissingIds.has(entryId)),
    );
    const pendingStandingsEntryIds = new Set(pendingStandings);
    const overallRankPlan = planClassicOverallRankRefresh(
      classicOverallRankTargets,
      classicOverallRankTargets.filter(
        (entryId) => !pendingStandingsEntryIds.has(entryId) && rows.has(entryId),
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
      const backgroundWorkKey = `${backgroundKey}:standings:${pendingStandings
        .slice()
        .sort((left, right) => left - right)
        .join(',')}:overall-rank:${pendingOverallRank
        .slice()
        .sort((left, right) => left - right)
        .join(',')}:page:${standings.nextPage}:complete:${standings.complete}`;
      const backgroundSeedRows = new Map(rows);
      scheduleBackgroundRefresh(backgroundKey, backgroundWorkKey, async () => {
        const backgroundRows = await readCachedAndCheckpointRows(
          redis,
          season,
          input.eventId,
          scope,
          backgroundEntryIds,
          backgroundSeedRows,
        );

        // A distinct overlapping request may have queued while another task
        // was refreshing this scope. Re-check the latest rows when this turn
        // starts so queued subsets do not repeat standings or Summary calls.
        let unresolvedStandings = pendingStandings.filter((entryId) => {
          const row = backgroundRows.get(entryId);
          return !row || !isFresh(row);
        });
        const unresolvedStandingsAtStart = new Set(unresolvedStandings);
        const latestOverallRankMarkers = await readOverallRankRefreshMarkers(
          redis,
          season.seasonCode,
          input.eventId,
          scope,
          pendingOverallRank,
        );
        let unresolvedOverallRank = pendingOverallRank.filter((entryId) =>
          shouldRetryPendingClassicOverallRank(
            entryId,
            unresolvedStandingsAtStart.has(entryId),
            overallRankMarkerBaseline,
            latestOverallRankMarkers,
          ),
        );
        if (unresolvedStandings.length === 0 && unresolvedOverallRank.length === 0) {
          logDebug('Official classic manager background refresh already satisfied', {
            eventId: input.eventId,
            leagueId: classicLeagueId,
          });
          return;
        }

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
          const fallbackOverallRanks = new Set(fallbackRefresh.overallRankRefreshedEntryIds);
          unresolvedStandings = unresolvedStandings.filter(
            (entryId) => !fallbackRefreshed.has(entryId),
          );
          unresolvedOverallRank = unresolvedOverallRank.filter(
            (entryId) => !fallbackOverallRanks.has(entryId),
          );
        }

        const unresolvedStandingsEntryIds = new Set(unresolvedStandings);
        const overallRankTargets = unresolvedOverallRank.filter(
          (entryId) => !unresolvedStandingsEntryIds.has(entryId) && backgroundRows.has(entryId),
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
      const backgroundWorkKey = `${backgroundKey}:entries:${pending
        .slice()
        .sort((left, right) => left - right)
        .join(',')}`;
      scheduleBackgroundRefresh(backgroundKey, backgroundWorkKey, async () => {
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
