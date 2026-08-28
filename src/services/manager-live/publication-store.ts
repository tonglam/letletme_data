// Manager Live publication implementation. Kept behind the compatibility facade.
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { fplClient, type RawFPLLeagueStandingsResponse } from '../../clients/fpl';
import { publishManagerLiveCacheMonotonically } from '../../cache/manager-live-publication';
import { readDatabaseOrderingTimestamp } from '../../db/ordering-timestamp';
import {
  managerScoreCheckpointRepository,
  type ManagerScoreCheckpoint,
  type ManagerScoreScope,
} from '../../repositories/live-window';
import { managerEventScoreSnapshotsInFpl } from '../../db/schemas/live-window.schema';
import { logWarn } from '../../utils/logger';
import type { FplSeasonRef } from '../../domain/fpl-season';
import {
  MANAGER_LIVE_CLASSIC_MAX_PAGE,
  MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT,
} from '../../domain/manager-live-refresh';
import {
  isPositiveOverallRank,
  preserveLastKnownOverallRank,
  reconcileMonotonicCachePublicationRows,
  selectEarlierManagerLiveObservationAt,
  selectLatestCheckedRow,
  shouldPreferEntrySummaryForClassicHeadline,
  shouldReplaceManagerLiveRow,
} from '../../domain/manager-live-fallback';
import type { ManagerLiveScoreRow, ManagerLiveSource, ManagerLiveTotalScope } from './contracts';

export const CACHE_TTL_SECONDS = 48 * 60 * 60;

// Refresh at 30s while an event is active, but keep a successfully published
// official row fresh for at least three refresh cycles. This prevents a
// transient refresh miss from being presented as stale immediately.
export const REFRESH_SECONDS = 30;

export const INCOMPLETE_CLASSIC_REFRESH_SECONDS = 15;

export const STALE_SECONDS = Math.max(90, 3 * REFRESH_SECONDS);

export const MAX_STANDINGS_PAGES = MANAGER_LIVE_CLASSIC_MAX_PAGE;

export const MAX_FOREGROUND_STANDINGS_PAGES = 4;

export const MANAGER_LIVE_READ_THROUGH_BACKGROUND_STANDINGS_PAGE_LIMIT =
  MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT;

export const MAX_BACKGROUND_STANDINGS_PAGES =
  MANAGER_LIVE_READ_THROUGH_BACKGROUND_STANDINGS_PAGE_LIMIT;

export const MAX_FOREGROUND_SUMMARY_FETCHES = 4;

// A small classic roster should receive a complete OR column in the initial
// response. Larger leagues remain bounded and finish through the background
// refresh below.
export const MAX_FOREGROUND_OVERALL_RANK_FETCHES = 20;

export const REFRESH_DISPATCH_DEADLINE_MS = 100;

// One serialized background unit fetches at most one FPL standings page or one
// entry summary. Keep its lease longer than the client's 40-second logical
// request deadline, and renew it while publication/checkpoint work finishes.
export const CLASSIC_REFRESH_LOCK_SECONDS = 60;

export const CLASSIC_REFRESH_LOCK_WAIT_MS = 100;

// Match the manager-row freshness window. Every replica refreshing the same
// season/event/entry during that window must reuse one unversioned observation.
export const ENTRY_SUMMARY_SHARED_RESULT_SECONDS = REFRESH_SECONDS;

export const RELEASE_CLASSIC_REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const RENEW_CLASSIC_REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export type CachedRow = ManagerLiveScoreRow;

export type ManagerLiveRowBacking = 'REDIS' | 'POSTGRES' | 'UPSTREAM';

export type ManagerSummaryRefreshError = 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null;

export type EntrySummaryRefreshResult = {
  errorCode: ManagerSummaryRefreshError;
  refreshedEntryIds: readonly number[];
  overallRankRefreshedEntryIds: readonly number[];
};

export const entryScope: ManagerScoreScope = { scopeType: 'ENTRY', scopeId: 0 };

/**
 * Finalized manager-live data is scoped by the entry's event eligibility. An
 * entry that joined in GW4 is a valid tournament member, but it has no GW1-3
 * result to fetch. Keep that entry out of the finalized denominator so it
 * cannot create a synthetic missing-row retry storm.
 *
 * Unknown start metadata remains eligible (the shared helper deliberately
 * treats it as such), which fails closed at the final-result persistence
 * boundary instead of silently declaring a row not applicable.
 */
export const scopeKey = (scope: ManagerScoreScope): string => `${scope.scopeType}:${scope.scopeId}`;

export const cacheKey = (season: string, eventId: number, scope: ManagerScoreScope): string =>
  `OfficialManagerLive:${season}:${eventId}:${scopeKey(scope)}`;

export const metaCacheKey = (season: string, eventId: number, scope: ManagerScoreScope): string =>
  `OfficialManagerLiveMeta:${season}:${eventId}:${scopeKey(scope)}`;

export const cacheOrderKey = (season: string, eventId: number, scope: ManagerScoreScope): string =>
  `OfficialManagerLiveOrder:${season}:${eventId}:${scopeKey(scope)}`;

export const overallRankMarkerCacheKey = (
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
): string => `OfficialManagerOverallRankMarker:${season}:${eventId}:${scopeKey(scope)}`;

export const stableRevision = (row: Omit<ManagerLiveScoreRow, 'revision'>): string => {
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

export const withRevision = (row: Omit<ManagerLiveScoreRow, 'revision'>): ManagerLiveScoreRow => ({
  ...row,
  revision: stableRevision(row),
});

export const withOverallRank = (
  row: ManagerLiveScoreRow,
  overallRank: number | null,
): ManagerLiveScoreRow => {
  if (overallRank === row.overallRank) return row;

  const { revision: _revision, ...withoutRevision } = row;
  return withRevision({ ...withoutRevision, overallRank });
};

export const withPreservedOverallRank = (
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

export const mergeLatestManagerLiveRow = (
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

export const toManagerScoreCheckpoint = (
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

export const fromManagerScoreCheckpoint = (
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

export const parseCachedRow = (value: string | null): CachedRow | null => {
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

export const readCachedRows = async (
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

export const mergeLatestRows = (
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

export const readCachedRowsForPublication = async (
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

export const readCachedAndCheckpointRows = async (
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

export const readBackgroundRows = async (
  redis: Redis | null,
  season: FplSeasonRef,
  eventId: number,
  scope: ManagerScoreScope,
  entryIds: readonly number[],
  capturedRows: ReadonlyMap<number, CachedRow>,
): Promise<Map<number, CachedRow>> =>
  readCachedAndCheckpointRows(redis, season, eventId, scope, entryIds, capturedRows);

export const readClassicPublicationState = async (
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

export const writeRows = async (
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

export const writeClassicRowsMonotonically = async (
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

export const reconcileClassicRowsAfterCachePublication = async (
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

export const writeCheckpointRows = async (
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

export const nowIso = (): string => new Date().toISOString();

export const plusSeconds = (checkedAt: string, seconds: number): string =>
  new Date(Date.parse(checkedAt) + seconds * 1000).toISOString();

/**
 * Side-effect ports for the bounded Classic standings crawl.
 *
 * Production callers use the adapters below by default. Unit callers can
 * supply deterministic fakes without constructing a database transaction or
 * opening a Redis connection, which keeps the refresh contract hermetic while
 * preserving the existing public refreshClassicStandings signature.
 */
export type ClassicStandingsRefreshDependencies = {
  fetchStandings: (
    leagueId: number,
    standingsPage: number,
    newEntriesPage?: number,
    requestOptions?: Parameters<typeof fplClient.getLeagueClassicStandings>[3],
  ) => Promise<RawFPLLeagueStandingsResponse>;
  readCachedRowsForPublication: typeof readCachedRowsForPublication;
  readPublicationState: typeof readClassicPublicationState;
  runPublication: <T>(key: string, task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  readOrderingTimestamp: typeof readDatabaseOrderingTimestamp;
  writeCheckpointRows: typeof writeCheckpointRows;
  writeCache: typeof writeClassicRowsMonotonically;
  reconcileCache: typeof reconcileClassicRowsAfterCachePublication;
};

export const classicStandingNeedsOverallRank = (
  row: Pick<CachedRow, 'source' | 'overallRank'> | undefined,
): boolean =>
  row?.source === 'FPL_CLASSIC_STANDINGS' &&
  (!isPositiveOverallRank(row.overallRank) || row.overallRank <= 0);

export const toEntrySummaryRow = (
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

export const toClassicRows = (
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
