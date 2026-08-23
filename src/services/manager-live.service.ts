import { createHash, randomBytes } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import type Redis from 'ioredis';
import type postgres from 'postgres';

import { EntrySummarySchema, fplClient, type RawFPLLeagueStandingsResponse } from '../clients/fpl';
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
  acquireDistributedLease,
  classicManagerBackgroundStandingsStartPage,
  classicManagerSummaryFallbackEntryIds,
  classicManagerSummaryFallbackNeedsRefresh,
  createDistributedLeaseFence,
  createKeyedSerialTaskGate,
  createKeyedSerialTaskScheduler,
  createKeyedTaskSerializer,
  createManagerSummaryFetchGate,
  isNewerClassicOverallRankPublicationOrder,
  isPositiveOverallRank,
  managerLiveBackgroundRefreshKey,
  managerSummaryFetchBatches,
  mergeUniqueTargetManagerRows,
  pendingManagerRefreshEntryIds,
  planClassicManagerFallback,
  planManagerLiveRefreshTargets,
  preserveLastKnownOverallRank,
  reconcileMonotonicCachePublicationRows,
  readThroughManagerSummaryResult,
  requireManagerSummaryCoordinator,
  runManagerStandingsPageSequence,
  runYieldingKeyedTask,
  selectClassicSummaryOverallRank,
  selectForegroundClassicRankEntryIds,
  selectLatestCheckedRow,
  shouldEnrichClassicOverallRank,
  shouldPreserveClassicStandingForRank,
  shouldRefreshClassicOverallRank,
  shouldReplaceManagerLiveRow,
  type ManagerSummaryFetchPriority,
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
// A small classic roster should receive a complete OR column in the initial
// response. Larger leagues remain bounded and finish through the background
// refresh below.
const MAX_FOREGROUND_OVERALL_RANK_FETCHES = 20;
// One serialized background unit fetches at most one FPL standings page or one
// entry summary. Keep its lease longer than the client's 40-second logical
// request deadline, and renew it while publication/checkpoint work finishes.
const CLASSIC_REFRESH_LOCK_SECONDS = 60;
const CLASSIC_REFRESH_LOCK_WAIT_MS = 100;
// Match the manager-row freshness window. Every replica refreshing the same
// season/event/entry during that window must reuse one unversioned observation.
const ENTRY_SUMMARY_SHARED_RESULT_SECONDS = REFRESH_SECONDS;

const RELEASE_CLASSIC_REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const RENEW_CLASSIC_REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

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
      !Number.isFinite(Date.parse(row.checkedAt)) ||
      typeof row.revision !== 'string' ||
      (row.source !== 'FPL_ENTRY_SUMMARY' &&
        row.source !== 'FPL_CLASSIC_STANDINGS' &&
        row.source !== 'FPL_FINAL_RESULT')
    ) {
      return null;
    }
    if (
      typeof row.staleAt !== 'string' ||
      !Number.isFinite(Date.parse(row.staleAt)) ||
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

const mergeLatestRows = (
  target: Map<number, CachedRow>,
  incoming: ReadonlyMap<number, CachedRow>,
): void => {
  for (const [entryId, row] of incoming) {
    const current = target.get(entryId);
    if (!current || shouldReplaceManagerLiveRow(current, row)) {
      target.set(entryId, current ? withPreservedOverallRank(row, current.overallRank) : row);
    }
  }
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

const readBackgroundRows = async (
  redis: Redis | null,
  season: FplSeasonRef,
  eventId: number,
  scope: ManagerScoreScope,
  entryIds: readonly number[],
  capturedRows: ReadonlyMap<number, CachedRow>,
): Promise<Map<number, CachedRow>> =>
  readCachedAndCheckpointRows(redis, season, eventId, scope, entryIds, capturedRows);

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

const nowIso = (): string => new Date().toISOString();

const plusSeconds = (checkedAt: string, seconds: number): string =>
  new Date(Date.parse(checkedAt) + seconds * 1000).toISOString();

const classicStandingNeedsOverallRank = (row: CachedRow | undefined): boolean =>
  row?.source === 'FPL_CLASSIC_STANDINGS' &&
  (!isPositiveOverallRank(row.overallRank) || row.overallRank <= 0);

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
// Every classic standings crawl and its OR enrichment share one prioritized
// lane for a season/event/league. Foreground misses jump ahead of queued
// background work; disjoint jobs remain queued and different leagues proceed
// independently.
const runClassicStandingsRefreshLocal = createKeyedTaskSerializer();

const classicRefreshLockKey = (key: string): string =>
  `OfficialManagerLiveRefreshLock:${createHash('sha256').update(key).digest('hex')}`;

class ManagerLiveLeaseOwnershipError extends Error {
  constructor(key: string, cause: unknown) {
    super(`official manager refresh lease ownership lost for ${key}`, { cause });
    this.name = 'ManagerLiveLeaseOwnershipError';
  }
}

const entrySummarySharedResultKey = (season: string, eventId: number, entryId: number): string =>
  `OfficialManagerLiveEntrySummaryResult:${season}:${eventId}:${entryId}`;

type ManagerSummaryObservation = Readonly<{
  summary: Awaited<ReturnType<typeof fplClient.getEntrySummary>>;
  observedAt: string;
  publicationOrder: string | null;
}>;

const parseManagerSummaryObservation = (value: string): ManagerSummaryObservation | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as {
      summary?: unknown;
      observedAt?: unknown;
      publicationOrder?: unknown;
    };
    if (typeof candidate.observedAt !== 'string') return null;
    const observedAtDate = new Date(candidate.observedAt);
    if (
      !Number.isFinite(observedAtDate.getTime()) ||
      observedAtDate.toISOString() !== candidate.observedAt
    ) {
      return null;
    }
    const publicationOrder = candidate.publicationOrder ?? null;
    if (publicationOrder !== null && typeof publicationOrder !== 'string') return null;
    const validated = EntrySummarySchema.safeParse(candidate.summary);
    return validated.success
      ? { summary: validated.data, observedAt: candidate.observedAt, publicationOrder }
      : null;
  } catch {
    return null;
  }
};

const runClassicStandingsRefresh = <T>(
  redis: Redis | null,
  key: string,
  task: (assertLeaseOwned: () => Promise<void>) => Promise<T>,
  priority: ManagerSummaryFetchPriority = 'foreground',
  options: { acquireFailureMode?: 'fail-open' | 'fail-closed' } = {},
): Promise<T> => {
  if (!redis) {
    return runClassicStandingsRefreshLocal(key, () => task(async () => undefined), priority);
  }

  const lockKey = classicRefreshLockKey(key);
  return runYieldingKeyedTask<T>(
    runClassicStandingsRefreshLocal,
    key,
    async () => {
      const lockToken = randomBytes(16).toString('hex');
      const acquisition = await acquireDistributedLease(
        async () =>
          (await redis.set(lockKey, lockToken, 'EX', CLASSIC_REFRESH_LOCK_SECONDS, 'NX')) === 'OK',
        options.acquireFailureMode ?? 'fail-open',
        (error) =>
          logWarn('Official manager distributed refresh lock unavailable', {
            key,
            error: error instanceof Error ? error.message : 'unknown',
          }),
      );
      if (acquisition === 'uncoordinated') {
        // Classic standings have an upstream publication clock and a durable
        // PostgreSQL ordering guard, so they remain serviceable if Redis is
        // unavailable. Unversioned entry summaries opt into fail-closed below.
        return { complete: true, value: await task(async () => undefined) };
      }
      if (acquisition === 'contended') {
        // A present lease is either actively renewed or will expire. Never
        // bypass an owner merely because this waiter is old: Redis expiry is
        // the takeover signal for a crashed/wedged owner, while an active
        // renewal proves that concurrent publication would be unsafe.
        return { complete: false };
      }

      const leaseFence = createDistributedLeaseFence(
        async () =>
          (await redis.eval(
            RENEW_CLASSIC_REFRESH_LOCK_SCRIPT,
            1,
            lockKey,
            lockToken,
            CLASSIC_REFRESH_LOCK_SECONDS,
          )) === 1,
        (error) =>
          logWarn('Official manager distributed refresh lease lost', {
            key,
            error: error instanceof Error ? error.message : 'unknown',
          }),
      );
      const renewTimer = setInterval(
        leaseFence.renewInBackground,
        Math.max(1_000, Math.floor((CLASSIC_REFRESH_LOCK_SECONDS * 1000) / 3)),
      );
      renewTimer.unref?.();

      try {
        const value = await task(leaseFence.assertOwned);
        await leaseFence.assertOwned();
        return { complete: true, value };
      } catch (error) {
        // A task may fail after a renewal was lost but before it reaches its
        // final fence. Probe once more so request paths can distinguish lease
        // loss from an ordinary upstream/publication failure and preserve
        // last-good rows instead of throwing the request.
        try {
          await leaseFence.assertOwned();
        } catch (leaseError) {
          throw new ManagerLiveLeaseOwnershipError(key, leaseError);
        }
        throw error;
      } finally {
        clearInterval(renewTimer);
        await redis
          .eval(RELEASE_CLASSIC_REFRESH_LOCK_SCRIPT, 1, lockKey, lockToken)
          .catch(() => undefined);
      }
    },
    priority,
    () => new Promise((resolve) => setTimeout(resolve, CLASSIC_REFRESH_LOCK_WAIT_MS)),
  );
};

const fetchDistributedManagerSummary = (
  redis: Redis | null,
  season: string,
  eventId: number,
  entryId: number,
  priority: ManagerSummaryFetchPriority = 'foreground',
  publicationKey?: string,
): Promise<ManagerSummaryObservation> => {
  const coordinator = requireManagerSummaryCoordinator(redis);
  return runClassicStandingsRefresh(
    coordinator,
    `entry-summary:${season}:${eventId}:${entryId}`,
    (assertLeaseOwned) =>
      readThroughManagerSummaryResult(
        async () => {
          try {
            const value = await coordinator.get(
              entrySummarySharedResultKey(season, eventId, entryId),
            );
            if (!value) return null;
            return parseManagerSummaryObservation(value);
          } catch (error) {
            logWarn('Official manager shared entry summary read failed', {
              entryId,
              error: error instanceof Error ? error.message : 'unknown',
            });
            // Without the shared handoff read, another replica's validated
            // observation cannot be distinguished from a new unversioned
            // response. Fail closed and keep last-good rows.
            throw error;
          }
        },
        async () => {
          let publicationOrder: string | null = null;
          const summary = await runManagerSummaryFetch(
            async () =>
              publicationKey
                ? fplClient.getEntrySummary(entryId, {
                    beforeAttempt: async (_attempt, { signal }) => {
                      publicationOrder = (
                        await reserveManagerLivePublicationStartedAt(publicationKey, signal)
                      ).exact;
                    },
                  })
                : fplClient.getEntrySummary(entryId),
            priority,
            entryId,
          );
          return { summary, observedAt: nowIso(), publicationOrder };
        },
        async (observation) => {
          try {
            await assertLeaseOwned();
            await coordinator.set(
              entrySummarySharedResultKey(season, eventId, entryId),
              JSON.stringify(observation),
              'EX',
              ENTRY_SUMMARY_SHARED_RESULT_SECONDS,
            );
          } catch (error) {
            logWarn('Official manager shared entry summary write failed', {
              entryId,
              error: error instanceof Error ? error.message : 'unknown',
            });
            // Do not publish a response that other replicas cannot reuse.
            // Otherwise a subsequent unversioned fetch could still regress it.
            throw error;
          }
        },
      ),
    priority,
    { acquireFailureMode: 'fail-closed' },
  );
};
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
    assertLeaseOwned?: () => Promise<void>;
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
          const observation = await fetchDistributedManagerSummary(
            redis,
            season.seasonCode,
            eventId,
            entryId,
            options.priority,
            classicScope ? publicationKey : undefined,
          );
          return {
            entryId,
            summary: observation.summary,
            publicationOrder: observation.publicationOrder,
          };
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
        await options.assertLeaseOwned?.();
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
      await options.assertLeaseOwned?.();
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
  assertLeaseOwned: () => Promise<void> = async () => undefined,
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
          await assertLeaseOwned();
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
      await assertLeaseOwned();
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
  const refreshNow = Date.now();
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
  );
  const staleOrMissing = refreshPlan.backgroundEntryIds;
  const foregroundRefreshTargets = refreshPlan.foregroundEntryIds;
  const coldEntryIds = new Set(foregroundRefreshTargets);
  const staleLastGoodCount = staleOrMissing.filter((entryId) =>
    usableCachedEntryIds.has(entryId),
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
    if (pending.length > 0) {
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
                    {},
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
              ...nextStandings.refreshedEntryIds,
            ]);
            const refreshedRankCandidateIds = new Set(nextStandings.refreshedEntryIds);
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
    const deferredForegroundRankTargets = standings.refreshedEntryIds.filter(
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
    if (backgroundEntryIds.length > 0) {
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
      scheduleBackgroundRefresh(backgroundKey, backgroundWorkKey, async () => {
        let backgroundRows = new Map(capturedBackgroundRows);
        let backgroundResult: Awaited<ReturnType<typeof refreshClassicStandings>> = {
          complete: standings.complete,
          nextPage: standings.nextPage,
          errorCode: null,
          refreshedEntryIds: [],
        };
        if (backgroundPlan.backgroundStandingsEntryIds.length > 0) {
          backgroundResult = await runManagerStandingsPageSequence(
            backgroundStandingsStartPage,
            MAX_STANDINGS_PAGES,
            (page) =>
              runClassicStandingsRefresh(
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
              ),
          );
        }

        // Only rows refreshed by a successful page (plus rows that were
        // already fresh rank-only targets) may receive OR enrichment. A failed
        // crawl must not stamp an old standings row fresh through summary data.
        const refreshedStandingsIds = new Set([
          ...deferredForegroundRankTargets,
          ...backgroundResult.refreshedEntryIds,
        ]);
        const rankOnlyEntryIds = new Set(
          rankOnlyTargets.filter((entryId) => !refreshedStandingsIds.has(entryId)),
        );
        const backgroundRankTargets = Array.from(
          new Set([...rankOnlyTargets, ...backgroundResult.refreshedEntryIds]),
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
                return classicManagerSummaryFallbackNeedsRefresh(row, row ? isFresh(row) : false);
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
      });
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
    if (pending.length > 0) {
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
