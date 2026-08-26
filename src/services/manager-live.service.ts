import { createHash, randomBytes } from 'node:crypto';

import type Redis from 'ioredis';
import type postgres from 'postgres';

import { EntrySummarySchema, fplClient, type RawFPLLeagueStandingsResponse } from '../clients/fpl';
import { publishManagerLiveCacheMonotonically } from '../cache/manager-live-publication';
import { redisSingleton } from '../cache/singleton';
import { getDb, runInDatabaseTransaction } from '../db/singleton';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import {
  managerScoreCheckpointRepository,
  managerLiveTournamentCoverageRepository,
  type ManagerLiveTournamentCoverageState,
  type ManagerScoreCheckpoint,
  type ManagerScoreScope,
} from '../repositories/live-window';
import { managerEventScoreSnapshotsInFpl } from '../db/schemas/live-window.schema';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { FPLClientError, ValidationError } from '../utils/errors';
import { logDebug, logWarn } from '../utils/logger';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  finalManagerRevision,
  isFinalManagerLiveRevision,
  tournamentRosterRevision,
} from '../domain/manager-live-coverage';
import {
  MANAGER_LIVE_CLASSIC_MAX_PAGE,
  MANAGER_LIVE_CLASSIC_CAPPED_CURSOR,
  MANAGER_LIVE_WORKER_CLASSIC_OR_FETCH_LIMIT,
  MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT,
  MANAGER_LIVE_WORKER_REQUEST_DEADLINE_MS,
  MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT,
  classicStandingsCursorAfterRefresh,
} from '../domain/manager-live-refresh';
export { classicStandingsCursorAfterRefresh } from '../domain/manager-live-refresh';
export { tournamentRosterRevision } from '../domain/manager-live-coverage';
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
  rotateManagerLiveEntryIds,
  runManagerStandingsPageSequence,
  runYieldingKeyedTask,
  selectClassicSummaryOverallRank,
  selectEarlierManagerLiveObservationAt,
  selectForegroundClassicRankEntryIds,
  selectLatestCheckedRow,
  shouldEnrichClassicOverallRank,
  shouldPreferEntrySummaryForClassicHeadline,
  shouldPreserveClassicStandingForRank,
  shouldRefreshClassicOverallRank,
  shouldReplaceManagerLiveRow,
  type ManagerSummaryFetchPriority,
} from '../domain/manager-live-fallback';
import { dispatchManagerLiveRefresh } from './manager-live-refresh-dispatch';
import {
  eventLiveManagerScoreService,
  type EventLiveManagerScoreBatch,
} from './event-live-manager-scores.service';

const CACHE_TTL_SECONDS = 48 * 60 * 60;
// Refresh at 30s while an event is active, but keep a successfully published
// official row fresh for at least three refresh cycles. This prevents a
// transient refresh miss from being presented as stale immediately.
const REFRESH_SECONDS = 30;
const INCOMPLETE_CLASSIC_REFRESH_SECONDS = 15;
const STALE_SECONDS = Math.max(90, 3 * REFRESH_SECONDS);
const MAX_STANDINGS_PAGES = MANAGER_LIVE_CLASSIC_MAX_PAGE;
const MAX_FOREGROUND_STANDINGS_PAGES = 4;
const MAX_FOREGROUND_SUMMARY_FETCHES = 4;
// A small classic roster should receive a complete OR column in the initial
// response. Larger leagues remain bounded and finish through the background
// refresh below.
const MAX_FOREGROUND_OVERALL_RANK_FETCHES = 20;
const REFRESH_DISPATCH_DEADLINE_MS = 100;
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

export type ManagerLiveSource =
  | 'FPL_EVENT_LIVE'
  | 'FPL_ENTRY_SUMMARY'
  | 'FPL_CLASSIC_STANDINGS'
  | 'FPL_FINAL_RESULT';
export type ManagerLiveTotalScope = 'OVERALL' | 'CLASSIC_PHASE';
export type ManagerLiveReadMode = 'CACHE_ONLY' | 'READ_THROUGH';
export type ManagerLiveDataAvailability = 'FRESH' | 'LAST_GOOD' | 'PARTIAL' | 'UNAVAILABLE';
export type ManagerLiveServedFrom = 'REDIS' | 'POSTGRES' | 'MIXED' | 'NONE';
export type ManagerLiveTournamentCoverage = {
  rosterRevision: string;
  expectedEntries: number;
  resolvedEntries: number;
  fullyFetchedAt: string | null;
  managerRevision: string | null;
  error: string | null;
  state: ManagerLiveTournamentCoverageState;
};

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
  tournamentCoverage?: ManagerLiveTournamentCoverage | null;
  /** Internal worker continuation; absent on public cache-only reads. */
  classicStandingsNextPage?: number | null;
};

type CachedRow = ManagerLiveScoreRow;
type ManagerLiveRowBacking = 'REDIS' | 'POSTGRES' | 'UPSTREAM';
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

export const mergeClassicStandingWithEntrySummary = (
  classicRow: CachedRow | undefined,
  entrySummaryRow: CachedRow | undefined,
): CachedRow | undefined => {
  if (!classicRow) return entrySummaryRow;
  if (!shouldPreferEntrySummaryForClassicHeadline(classicRow, entrySummaryRow)) {
    return classicRow;
  }
  if (!entrySummaryRow) return classicRow;

  const { revision: _revision, ...entrySummary } = entrySummaryRow;
  const checkedAt = selectEarlierManagerLiveObservationAt(
    classicRow.checkedAt,
    entrySummaryRow.checkedAt,
  );
  return withRevision({
    ...entrySummary,
    checkedAt,
    staleAt: plusSeconds(checkedAt, STALE_SECONDS),
    // Classic standings remains the authority for this tournament's league
    // position. Entry Summary is the authority for the event/overall headline.
    leagueRank: classicRow.leagueRank,
    overallRank: preserveLastKnownOverallRank(entrySummary.overallRank, classicRow.overallRank),
  });
};

const mergeLatestManagerLiveRow = (
  current: CachedRow | undefined,
  candidate: CachedRow,
): CachedRow => {
  const currentRevisionAt = Date.parse(
    (current as (CachedRow & { revisionAt?: string }) | undefined)?.revisionAt ?? '',
  );
  const candidateRevisionAt = Date.parse(
    (candidate as CachedRow & { revisionAt?: string }).revisionAt ?? '',
  );
  if (current && Date.parse(current.checkedAt) === Date.parse(candidate.checkedAt)) {
    const currentCheckedAt = Date.parse(current.checkedAt);
    const normalizedCurrentRevisionAt = Number.isFinite(currentRevisionAt)
      ? currentRevisionAt
      : currentCheckedAt;
    const normalizedCandidateRevisionAt = Number.isFinite(candidateRevisionAt)
      ? candidateRevisionAt
      : currentCheckedAt;
    if (normalizedCurrentRevisionAt !== normalizedCandidateRevisionAt) {
      const latestByRevision =
        normalizedCandidateRevisionAt > normalizedCurrentRevisionAt ? candidate : current;
      const otherByRevision = latestByRevision === candidate ? current : candidate;
      return withPreservedOverallRank(latestByRevision, otherByRevision.overallRank);
    }
  }
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
): CachedRow & { revisionAt: string } => ({
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
  // `checkedAt` is the upstream observation identity and can legitimately be
  // unchanged when a later Classic overall-rank enrichment is persisted.
  // Keep the durable row's write ordering so it can beat an older Redis-only
  // enrichment with the same observation timestamp.
  revisionAt: row.updatedAt.toISOString(),
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
      (row.source !== 'FPL_EVENT_LIVE' &&
        row.source !== 'FPL_ENTRY_SUMMARY' &&
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
  sourceByEntry?: Map<number, ManagerLiveRowBacking>,
): Promise<Map<number, CachedRow>> => {
  const wantedEntryIds = new Set(entryIds);
  const rows = new Map<number, CachedRow>();
  for (const [entryId, row] of seedRows ?? []) {
    if (wantedEntryIds.has(entryId)) rows.set(entryId, row);
  }

  try {
    const cachedRows = await readCachedRows(redis, season.seasonCode, eventId, scope, entryIds);
    for (const [entryId, row] of cachedRows) {
      const current = rows.get(entryId);
      const merged = mergeLatestManagerLiveRow(current, row);
      rows.set(entryId, merged);
      if (sourceByEntry && merged === row) sourceByEntry.set(entryId, 'REDIS');
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
    const merged = cachedOrSeedRow
      ? mergeLatestManagerLiveRow(checkpointRow, cachedOrSeedRow)
      : checkpointRow;
    rows.set(checkpoint.entryId, merged);
    if (sourceByEntry && merged === checkpointRow)
      sourceByEntry.set(checkpoint.entryId, 'POSTGRES');
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
    const acceptedRowCount = await managerScoreCheckpointRepository.upsertBatch(
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
    if (acceptedRowCount !== rows.length) {
      logWarn('Official manager checkpoint publication was partially accepted', {
        eventId,
        scope: scopeKey(scope),
        expectedRows: rows.length,
        acceptedRows: acceptedRowCount,
      });
      return false;
    }
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

/**
 * Replace every active score field with a value derived from one coherent
 * event-live publication. Entry Summary and Classic rows contribute ranks
 * only; they can never override the active score.
 */
export const projectEventLiveManagerRows = (
  season: string,
  eventId: number,
  entryIds: readonly number[],
  metadataRows: readonly ManagerLiveScoreRow[],
  batch: EventLiveManagerScoreBatch | null,
): ManagerLiveScoreRow[] => {
  if (!batch || batch.season !== season || batch.eventId !== eventId) return [];
  const metadataByEntry = new Map(metadataRows.map((row) => [row.entryId, row] as const));
  return entryIds.flatMap((entryId) => {
    const score = batch.scores.get(entryId);
    if (!score) return [];
    const metadataCandidate = metadataByEntry.get(entryId);
    const batchCheckedAt = Date.parse(batch.checkedAt);
    const metadata =
      metadataCandidate &&
      Number.isFinite(batchCheckedAt) &&
      isFresh(metadataCandidate, batchCheckedAt)
        ? metadataCandidate
        : undefined;
    const metadataDigest = createHash('sha1')
      .update(
        JSON.stringify({
          eventRank: metadata?.eventRank ?? null,
          overallRank: metadata?.overallRank ?? null,
          leagueRank: metadata?.leagueRank ?? null,
        }),
      )
      .digest('hex')
      .slice(0, 16);
    return [
      {
        ...(metadata && 'revisionAt' in metadata
          ? { revisionAt: (metadata as CachedRow & { revisionAt?: string }).revisionAt }
          : {}),
        season,
        eventId,
        entryId,
        eventPoints: score.eventPoints,
        netEventPoints: score.netEventPoints,
        totalPoints: score.totalPoints,
        totalScope: 'OVERALL' as const,
        eventRank: metadata?.eventRank ?? null,
        overallRank: metadata?.overallRank ?? null,
        leagueRank: metadata?.leagueRank ?? null,
        source: 'FPL_EVENT_LIVE' as const,
        transferCost: score.transferCost,
        eventPointSemantics:
          score.transferCost === 0 ? ('ZERO_COST_EQUIVALENT' as const) : ('GROSS' as const),
        revision: `${score.revision}:metadata:${metadataDigest}`,
        checkedAt: batch.checkedAt,
        upstreamUpdatedAt: batch.sourceCheckedAt,
        staleAt: plusSeconds(batch.checkedAt, STALE_SECONDS),
      },
    ];
  });
};

const classicStandingNeedsOverallRank = (
  row: Pick<CachedRow, 'source' | 'overallRank'> | undefined,
): boolean =>
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

export const deriveManagerLiveTournamentCoverageState = (input: {
  expectedEntries: number;
  resolvedEntries: number;
  errorCode: ManagerLiveResolveResult['errorCode'];
  crawlComplete: boolean;
}): ManagerLiveTournamentCoverageState => {
  const complete =
    input.crawlComplete &&
    input.errorCode === null &&
    input.resolvedEntries === input.expectedEntries;
  if (complete) return 'COMPLETE';
  if (input.resolvedEntries > 0) return 'PARTIAL';
  if (input.errorCode) return 'UNAVAILABLE';
  return 'WARMING';
};

export const invalidateManagerLiveTournamentCoverage = (
  coverage: ManagerLiveTournamentCoverage | null,
  rosterRevision: string,
  expectedEntries: number,
): ManagerLiveTournamentCoverage | null => {
  if (!coverage || coverage.rosterRevision === rosterRevision) return coverage;
  return {
    ...coverage,
    rosterRevision,
    expectedEntries,
    resolvedEntries: 0,
    fullyFetchedAt: null,
    managerRevision: null,
    error: null,
    state: 'WARMING',
  };
};

export const shouldPreserveManagerLiveTournamentCoverage = (
  coverage: {
    state: string;
    rosterRevision: string;
    expectedEntries: number;
    resolvedEntries: number;
  } | null,
  rosterRevision: string,
  expectedEntries: number,
): boolean =>
  coverage?.state === 'COMPLETE' &&
  coverage.rosterRevision === rosterRevision &&
  coverage.expectedEntries === expectedEntries &&
  coverage.resolvedEntries === expectedEntries;

export const shouldQueueFinalizedManagerLiveCoverage = (
  coverage: Pick<
    ManagerLiveTournamentCoverage,
    'state' | 'rosterRevision' | 'expectedEntries' | 'resolvedEntries' | 'managerRevision'
  > | null,
  rosterRevision: string,
  expectedEntries: number,
): boolean =>
  !(
    coverage?.state === 'COMPLETE' &&
    coverage.rosterRevision === rosterRevision &&
    coverage.expectedEntries === expectedEntries &&
    coverage.resolvedEntries === expectedEntries &&
    isFinalManagerLiveRevision(coverage.managerRevision)
  );

const mapTournamentCoverage = (row: {
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

const readTournamentCoverage = async (
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

const persistTournamentCoverage = async (input: {
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
    await managerLiveTournamentCoverageRepository.upsert({
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
  } catch (error) {
    logWarn('Manager live tournament coverage publication failed', {
      eventId: input.eventId,
      tournamentId: input.tournamentId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
  return coverage;
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
  tournamentCoverage?: ManagerLiveTournamentCoverage | null;
  classicStandingsNextPage?: number | null;
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
    nextRefreshAt: input.nextRefreshAt,
    ...(input.tournamentCoverage === undefined
      ? {}
      : { tournamentCoverage: input.tournamentCoverage }),
    ...(input.classicStandingsNextPage === undefined
      ? {}
      : { classicStandingsNextPage: input.classicStandingsNextPage }),
  };
};

const buildActiveManagerLiveResult = async (input: {
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
}): Promise<ManagerLiveResolveResult> => {
  const batch = await eventLiveManagerScoreService
    .load(input.season, input.eventId, input.entryIds)
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
  return buildManagerLiveResult({
    season: input.season.seasonCode,
    eventId: input.eventId,
    rows,
    missingEntryIds,
    errorCode:
      missingEntryIds.length > 0 ? (input.errorCode ?? 'UPSTREAM_UNAVAILABLE') : input.errorCode,
    nextRefreshAt: input.nextRefreshAt,
    // `servedFrom` remains the response/cache backing contract. Score
    // authority is carried independently by row.source/revision/checkedAt.
    sourceByEntry: input.sourceByEntry,
    checkedAt: batch?.checkedAt ?? input.checkedAt,
    ...(input.tournamentCoverage === undefined
      ? {}
      : { tournamentCoverage: input.tournamentCoverage }),
    ...(input.refreshQueued === undefined ? {} : { refreshQueued: input.refreshQueued }),
    ...(input.classicStandingsNextPage === undefined
      ? {}
      : { classicStandingsNextPage: input.classicStandingsNextPage }),
  });
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

const fetchDistributedManagerSummary = async (
  redis: Redis | null,
  season: string,
  eventId: number,
  entryId: number,
  priority: ManagerSummaryFetchPriority = 'foreground',
  publicationKey?: string,
  publicationOrderingRequired = false,
  requestDeadlineMs?: number,
): Promise<ManagerSummaryObservation> => {
  // Some deployments (and the lightweight unit harness) expose only the
  // manager-row hash operations. In that mode there is no shared observation
  // coordinator; keep the durable checkpoint path usable with one bounded
  // official fetch rather than failing before contacting FPL.
  if (
    !redis ||
    typeof (redis as unknown as { get?: unknown }).get !== 'function' ||
    typeof (redis as unknown as { set?: unknown }).set !== 'function'
  ) {
    let publicationOrder: string | null = null;
    const summary = await runManagerSummaryFetch(
      async () =>
        publicationKey
          ? fplClient.getEntrySummary(entryId, {
              ...(requestDeadlineMs === undefined ? {} : { deadlineMs: requestDeadlineMs }),
              beforeAttempt: async (_attempt, { signal }) => {
                try {
                  publicationOrder = (
                    await reserveManagerLivePublicationStartedAt(publicationKey, signal)
                  ).exact;
                } catch (error) {
                  if (publicationOrderingRequired) throw error;
                  logWarn('Official manager summary ordering reservation failed', {
                    entryId,
                    error: error instanceof Error ? error.message : 'unknown',
                  });
                }
              },
            })
          : fplClient.getEntrySummary(
              entryId,
              requestDeadlineMs === undefined ? {} : { deadlineMs: requestDeadlineMs },
            ),
      priority,
      entryId,
    );
    return { summary, observedAt: nowIso(), publicationOrder };
  }
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
                    ...(requestDeadlineMs === undefined ? {} : { deadlineMs: requestDeadlineMs }),
                    beforeAttempt: async (_attempt, { signal }) => {
                      try {
                        publicationOrder = (
                          await reserveManagerLivePublicationStartedAt(publicationKey, signal)
                        ).exact;
                      } catch (error) {
                        if (publicationOrderingRequired) throw error;
                        logWarn('Official manager summary ordering reservation failed', {
                          entryId,
                          error: error instanceof Error ? error.message : 'unknown',
                        });
                      }
                    },
                  })
                : fplClient.getEntrySummary(
                    entryId,
                    requestDeadlineMs === undefined ? {} : { deadlineMs: requestDeadlineMs },
                  ),
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
export const runManagerLivePublication = <T>(
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> =>
  runManagerLivePublicationInProcess(
    key,
    async (): Promise<T> => {
      if (signal?.aborted) throw signal.reason;
      const db = await getDb();
      return (await db.transaction(async (drizzleTransaction) => {
        const transaction = (
          drizzleTransaction as unknown as {
            session?: { client?: postgres.TransactionSql };
          }
        ).session?.client;
        if (!transaction) {
          throw new Error('Drizzle transaction did not expose its pinned postgres client');
        }
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
        return runInDatabaseTransaction(transaction, task, drizzleTransaction);
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
    requestDeadlineMs?: number;
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
            // Every shared observation needs a scope-independent ordering
            // marker. A summary fetched through the ENTRY scope may later be
            // reused by the Classic scope. If the best-effort reservation is
            // unavailable, the null marker is rejected by Classic rather than
            // blocking this direct-entry refresh.
            publicationKey,
            classicScope,
            options.requestDeadlineMs,
          );
          return {
            entryId,
            summary: observation.summary,
            // A waiter must preserve the upstream observation time from the
            // shared result. Stamping a fresh local time here would extend a
            // nearly-expired summary for another full refresh interval.
            observedAt: observation.observedAt,
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
      redisPublished: boolean;
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
        ({ entryId, summary, observedAt, publicationOrder: summaryPublicationOrder }) => {
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
                // A Classic row combines two independently observed sources:
                // phase totals from standings and OR from Entry Summary. Its
                // freshness cannot be newer than either observation.
                const checkedAt = selectEarlierManagerLiveObservationAt(
                  classicRow.checkedAt,
                  observedAt,
                );
                return withRevision({
                  ...classicRow,
                  checkedAt,
                  staleAt: plusSeconds(checkedAt, STALE_SECONDS),
                  // Classic standings owns event/phase totals and league rank;
                  // the entry summary owns the season-wide FPL OR.
                  overallRank: summary.summary_overall_rank ?? null,
                });
              })()
            : toEntrySummaryRow(season.seasonCode, eventId, entryId, summary, observedAt);
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
          if (acceptOverallRank && isPositiveOverallRank(summary.summary_overall_rank)) {
            // mergeLatestManagerLiveRow may select a newer Classic standings
            // row after the Summary rank was applied. Reapply the bounded
            // observation time so the combined row cannot outlive either
            // source's evidence.
            const checkedAt = selectEarlierManagerLiveObservationAt(
              merged.checkedAt,
              orderedCandidate.checkedAt,
            );
            if (
              merged.overallRank !== summary.summary_overall_rank ||
              merged.checkedAt !== checkedAt
            ) {
              const { revision: _revision, ...withoutRevision } = merged;
              merged = withRevision({
                ...withoutRevision,
                overallRank: summary.summary_overall_rank,
                checkedAt,
                staleAt: plusSeconds(checkedAt, STALE_SECONDS),
              });
            }
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
          redisPublished: true,
        };
      }

      const redisPublished = await writeRows(
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
        redisPublished,
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
    const checkpointPublished = classicScope
      ? true
      : await writeCheckpointRows(season, eventId, scope, publishedBatch.rows);
    if (!checkpointPublished && !publishedBatch.redisPublished) {
      refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
      logWarn('Official manager summary had no durable publication', {
        eventId,
        scope: scopeKey(scope),
        entryCount: publishedBatch.rows.length,
      });
      continue;
    }
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

export const refreshClassicStandings = async (
  season: FplSeasonRef,
  eventId: number,
  leagueId: number,
  targetIds: ReadonlySet<number>,
  rows: Map<number, CachedRow>,
  redis: Redis | null,
  options: { startPage?: number; maxPages?: number; requestDeadlineMs?: number } = {},
  assertLeaseOwned: () => Promise<void> = async () => undefined,
): Promise<{
  complete: boolean;
  nextPage: number;
  errorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null;
  refreshedEntryIds?: readonly number[];
}> => {
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
      const response = await fplClient.getLeagueClassicStandings(
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
      if (redis === null) {
        // A cache outage should not prevent the PostgreSQL checkpoint from
        // accepting completed pages. This fallback retains page progress while
        // still refusing to advance when the durable write itself fails.
        const fallbackRows = uniqueFetchedRows.map((row) =>
          withPreservedOverallRank(row, rows.get(row.entryId)?.overallRank),
        );
        const fallbackPublished = await writeCheckpointRows(
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
  };
  // Keep the legacy public helper's structural result stable while exposing
  // the additive worker bookkeeping to internal callers.
  Object.defineProperty(result, 'refreshedEntryIds', {
    value: publishedRows.map((row) => row.entryId),
    enumerable: false,
    configurable: true,
  });
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

const workerProjectionEntryIds = (
  entryIds: readonly number[],
  workerTournamentRefresh: boolean,
): number[] =>
  workerTournamentRefresh
    ? entryIds.slice(0, MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT)
    : [...entryIds];

const managerLiveInFlight = new Map<string, Promise<ManagerLiveResolveResult>>();

const resolveManagerLiveScoresUncoalesced = async (input: {
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
  readMode?: ManagerLiveReadMode;
  completeRefresh?: boolean;
  classicStandingsStartPage?: number;
  summaryRotationCursor?: number;
}): Promise<ManagerLiveResolveResult> => {
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
  const tournamentCoverage = currentTournamentRosterRevision
    ? invalidateManagerLiveTournamentCoverage(
        existingTournamentCoverage,
        currentTournamentRosterRevision,
        coverageRosterEntryIds.length,
      )
    : existingTournamentCoverage;

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
    const finalErrorCode =
      resolvedIds.size === uniqueEntryIds.length ? null : ('UPSTREAM_UNAVAILABLE' as const);
    const projectionEntryIds = workerProjectionEntryIds(uniqueEntryIds, workerTournamentRefresh);
    const projectionEntryIdSet = new Set(projectionEntryIds);
    const projectedFinalRows = finalRows.filter((row) => projectionEntryIdSet.has(row.entryId));
    const projectedResolvedIds = new Set(projectedFinalRows.map((row) => row.entryId));
    let refreshQueued = false;
    if (
      input.tournamentId !== undefined &&
      !workerTournamentRefresh &&
      currentTournamentRosterRevision !== null &&
      shouldQueueFinalizedManagerLiveCoverage(
        tournamentCoverage,
        currentTournamentRosterRevision,
        coverageRosterEntryIds.length,
      )
    ) {
      try {
        refreshQueued =
          (await dispatchManagerLiveRefreshBounded({
            season,
            eventId: input.eventId,
            entryIds: coverageRosterEntryIds,
            tournamentId: input.tournamentId,
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
    });
    if (workerTournamentRefresh && input.tournamentId !== undefined) {
      const fullMissingEntryIds = uniqueEntryIds.filter((entryId) => !resolvedIds.has(entryId));
      const fullManagerRevision = managerRevision(
        season.seasonCode,
        input.eventId,
        finalRows,
        fullMissingEntryIds,
      );
      result.managerRevision = fullManagerRevision;
      const finalCoverageRosterRevision = tournamentRosterRevision(coverageRosterEntryIds);
      const finalCoverageComplete =
        finalErrorCode === null && resolvedIds.size === coverageRosterEntryIds.length;
      const finalCoverageCandidate: ManagerLiveTournamentCoverage = {
        rosterRevision: finalCoverageRosterRevision,
        expectedEntries: coverageRosterEntryIds.length,
        resolvedEntries: resolvedIds.size,
        fullyFetchedAt: finalCoverageComplete ? nowIso() : null,
        managerRevision: finalManagerRevision(fullManagerRevision),
        error: finalErrorCode,
        state: finalCoverageComplete
          ? 'COMPLETE'
          : resolvedIds.size > 0
            ? 'PARTIAL'
            : 'UNAVAILABLE',
      };
      const persistedCoverage = await persistTournamentCoverage({
        season,
        eventId: input.eventId,
        tournamentId: input.tournamentId,
        rosterRevision: finalCoverageRosterRevision,
        expectedEntries: coverageRosterEntryIds.length,
        rows: finalRows,
        errorCode: finalErrorCode,
        managerRevision: finalManagerRevision(fullManagerRevision),
        crawlComplete: resolvedIds.size === coverageRosterEntryIds.length,
      });
      result.tournamentCoverage = persistedCoverage ?? finalCoverageCandidate;
    }
    return result;
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
  if ((input.readMode ?? 'READ_THROUGH') === 'CACHE_ONLY') {
    const now = Date.now();
    const metadataRows = uniqueEntryIds
      .map((entryId) => rows.get(entryId))
      .filter((row): row is CachedRow => row !== undefined && isWithinStaleWindow(row, now));
    let refreshQueued = false;
    try {
      const dispatchState = await dispatchManagerLiveRefreshBounded({
        season,
        eventId: input.eventId,
        entryIds: uniqueEntryIds,
        ...(input.tournamentId === undefined ? {} : { tournamentId: input.tournamentId }),
      });
      // A dispatch that misses the response deadline is deliberately reported as
      // PENDING. Do not advertise it as queued until enqueue has been confirmed;
      // callers must be allowed to retry when the queue path is still unknown.
      refreshQueued = dispatchState === 'QUEUED';
    } catch (error) {
      logWarn('Manager live cache-only response could not queue a refresh', {
        eventId: input.eventId,
        tournamentId: input.tournamentId ?? null,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    return buildActiveManagerLiveResult({
      season,
      eventId: input.eventId,
      entryIds: uniqueEntryIds,
      metadataRows,
      errorCode: null,
      nextRefreshAt: nextRefresh(event.finished),
      sourceByEntry,
      refreshQueued,
      tournamentCoverage,
    });
  }

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
      Date.now() +
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

  const now = Date.now();
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
    ...(input.tournamentId === undefined ? {} : { tournamentCoverage }),
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
  summaryRotationCursor?: number;
}): Promise<ManagerLiveResolveResult> {
  const key = JSON.stringify({
    eventId: input.eventId,
    entryIds: Array.from(new Set(input.entryIds)).sort((left, right) => left - right),
    tournamentId: input.tournamentId ?? null,
    classicStandingsStartPage: input.classicStandingsStartPage ?? null,
    summaryRotationCursor: input.summaryRotationCursor ?? null,
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
