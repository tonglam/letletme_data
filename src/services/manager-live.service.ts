import { createHash, randomBytes } from 'node:crypto';

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
  classicManagerSummaryFallbackEntryIds,
  classicManagerSummaryFallbackNeedsRefresh,
  createKeyedTaskSerializer,
  createManagerSummaryFetchGate,
  managerLiveBackgroundRefreshKey,
  managerSummaryFetchBatches,
  pendingManagerRefreshEntryIds,
  type ManagerSummaryFetchPriority,
  planClassicManagerFallback,
  planManagerLiveRefreshTargets,
  preserveClassicOverallRank,
  runManagerStandingsPageSequence,
  runYieldingKeyedTask,
  selectForegroundClassicRankEntryIds,
  shouldReplaceManagerLiveRow,
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
// One serialized background unit fetches at most one FPL standings page. Keep
// its lease longer than the client's 40-second logical request deadline, and
// renew it while the page publication/checkpoint finishes.
const CLASSIC_REFRESH_LOCK_SECONDS = 60;
const CLASSIC_REFRESH_LOCK_WAIT_MS = 100;

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
    if (!current || shouldReplaceManagerLiveRow(current, row)) target.set(entryId, row);
  }
};

const readBackgroundRows = async (
  redis: Redis | null,
  season: FplSeasonRef,
  eventId: number,
  scope: ManagerScoreScope,
  entryIds: readonly number[],
  capturedRows: ReadonlyMap<number, CachedRow>,
): Promise<Map<number, CachedRow>> => {
  const rows = new Map<number, CachedRow>();
  mergeLatestRows(rows, capturedRows);
  try {
    mergeLatestRows(rows, await readCachedRows(redis, season.seasonCode, eventId, scope, entryIds));
  } catch (error) {
    logWarn('Official manager background Redis read failed; checking PostgreSQL checkpoint', {
      season: season.seasonCode,
      eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  // PostgreSQL is the durable publication boundary. Re-read it after entering
  // each serialized lane so a Redis outage (or a failed cache write) cannot
  // make a yielded background batch overwrite an intervening publication.
  try {
    const checkpoints = await managerScoreCheckpointRepository.findByScopeAndEntryIds(
      season,
      eventId,
      scope,
      entryIds,
    );
    mergeLatestRows(
      rows,
      new Map(
        checkpoints.map((checkpoint) => [
          checkpoint.entryId,
          fromManagerScoreCheckpoint(checkpoint, season.seasonCode),
        ]),
      ),
    );
  } catch (error) {
    logWarn('Official manager background checkpoint read failed; retaining latest live rows', {
      season: season.seasonCode,
      eventId,
      scope: scopeKey(scope),
      error: error instanceof Error ? error.message : 'unknown',
    });
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
// Every classic standings crawl and its OR enrichment share one prioritized
// lane for a season/event/league. Foreground misses jump ahead of queued
// background work; disjoint jobs remain queued and different leagues proceed
// independently.
const runClassicStandingsRefreshLocal = createKeyedTaskSerializer();

const classicRefreshLockKey = (key: string): string =>
  `OfficialManagerLiveRefreshLock:${createHash('sha256').update(key).digest('hex')}`;

const runClassicStandingsRefresh = <T>(
  redis: Redis | null,
  key: string,
  task: () => Promise<T>,
  priority: ManagerSummaryFetchPriority = 'foreground',
): Promise<T> => {
  if (!redis) return runClassicStandingsRefreshLocal(key, task, priority);

  const lockKey = classicRefreshLockKey(key);
  return runYieldingKeyedTask<T>(
    runClassicStandingsRefreshLocal,
    key,
    async () => {
      const lockToken = randomBytes(16).toString('hex');
      let lockOwner = false;
      try {
        lockOwner =
          (await redis.set(lockKey, lockToken, 'EX', CLASSIC_REFRESH_LOCK_SECONDS, 'NX')) === 'OK';
      } catch (error) {
        // Redis is an acceleration and coordination layer, not the source of
        // truth. Continue through the PostgreSQL checkpoint guard when it is
        // unavailable so live scores remain serviceable.
        logWarn('Official classic manager distributed refresh lock unavailable', {
          key,
          error: error instanceof Error ? error.message : 'unknown',
        });
        return { complete: true, value: await task() };
      }

      if (!lockOwner) {
        // A present lease is either actively renewed or will expire. Never
        // bypass an owner merely because this waiter is old: Redis expiry is
        // the takeover signal for a crashed/wedged owner, while an active
        // renewal proves that concurrent publication would be unsafe.
        return { complete: false };
      }

      const renewTimer = setInterval(
        () => {
          void redis
            .eval(
              RENEW_CLASSIC_REFRESH_LOCK_SCRIPT,
              1,
              lockKey,
              lockToken,
              CLASSIC_REFRESH_LOCK_SECONDS,
            )
            .catch(() => undefined);
        },
        Math.max(1_000, Math.floor((CLASSIC_REFRESH_LOCK_SECONDS * 1000) / 3)),
      );
      renewTimer.unref?.();

      try {
        return { complete: true, value: await task() };
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
): Promise<'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null> => {
  const targets = entryIds
    .filter((entryId) => options.force || !rows.has(entryId) || !isFresh(rows.get(entryId)!))
    .slice(0, options.maxFetches ?? Number.POSITIVE_INFINITY);
  if (targets.length === 0) return null;

  const refreshed: ManagerLiveScoreRow[] = [];
  let refreshErrorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null = null;
  for (const batch of managerSummaryFetchBatches(targets)) {
    const completedBatch: ManagerLiveScoreRow[] = [];
    await Promise.all(
      batch.map(async (entryId) => {
        try {
          const summary = await runManagerSummaryFetch(
            () => fplClient.getEntrySummary(entryId),
            options.priority,
            entryId,
          );
          const checkedAt = nowIso();
          const existing = rows.get(entryId);
          const row =
            options.preserveClassicStanding && existing?.source === 'FPL_CLASSIC_STANDINGS'
              ? (() => {
                  const { revision: _revision, ...classicRow } = existing;
                  return withRevision({
                    ...classicRow,
                    // Classic standings owns event/phase totals and league rank;
                    // the entry summary owns the season-wide FPL OR.
                    overallRank: preserveClassicOverallRank(
                      summary.summary_overall_rank ?? null,
                      existing.overallRank,
                    ),
                    // OR enrichment must not make an old standings snapshot
                    // appear fresh. Keep the standings publication clock so a
                    // failed/slow crawl remains eligible for the next refresh.
                    checkedAt: existing.checkedAt,
                    staleAt: existing.staleAt,
                  });
                })()
              : toEntrySummaryRow(season.seasonCode, eventId, entryId, summary, checkedAt);
          completedBatch.push(row);
          refreshed.push(row);
          rows.set(row.entryId, row);
          // Publish each completed response to the primary cache immediately.
          // A slow sibling or later batch must not hide already-fetched
          // official scores until the whole background crawl finishes.
          await writeRows(redis, season.seasonCode, eventId, scope, [row]);
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
    await managerScoreCheckpointRepository
      .upsertBatch(
        season,
        eventId,
        scope,
        completedBatch.map((row) => toManagerScoreCheckpoint(row)),
      )
      .catch((error) =>
        logWarn('Official manager checkpoint write failed', {
          eventId,
          scope: scopeKey(scope),
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
    const durableRows = await managerScoreCheckpointRepository
      .findByScopeAndEntryIds(
        season,
        eventId,
        scope,
        completedBatch.map((row) => row.entryId),
      )
      .catch((error) => {
        logWarn('Official manager checkpoint verification read failed', {
          eventId,
          scope: scopeKey(scope),
          error: error instanceof Error ? error.message : 'unknown',
        });
        return [];
      });
    mergeLatestRows(
      rows,
      new Map(
        durableRows.map((row) => [row.entryId, fromManagerScoreCheckpoint(row, season.seasonCode)]),
      ),
    );
  }
  return refreshErrorCode;
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
  const foundEntryIds = new Set<number>();
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
      foundEntryIds.size < targetIds.size;
      page += 1
    ) {
      const response = await fplClient.getLeagueClassicStandings(leagueId, page);
      nextPage = page + 1;
      const pageRows = toClassicRows(season.seasonCode, eventId, response, checkedAt);
      for (const row of pageRows) {
        if (!targetIds.has(row.entryId)) continue;
        const existing = rows.get(row.entryId);
        foundEntryIds.add(row.entryId);
        // Upstream's publication clock outranks this replica's local fetch
        // completion time. A slower replica must never re-stamp an older FPL
        // standings snapshot with a newer checkedAt and regress totals.
        if (existing && !shouldReplaceManagerLiveRow(existing, row)) continue;
        const overallRank = preserveClassicOverallRank(row.overallRank, existing?.overallRank);
        const publishedRow =
          overallRank !== row.overallRank
            ? (() => {
                const { revision: _revision, ...classicRow } = row;
                return withRevision({ ...classicRow, overallRank });
              })()
            : row;
        fetchedRows.push(publishedRow);
        rows.set(publishedRow.entryId, publishedRow);
      }
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

  // A later standings page can fail after earlier pages yielded useful rows.
  // Publish that successful prefix and return its IDs for serialized OR
  // enrichment instead of making the next poll fall back to the old cache.
  await writeRows(
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
  await managerScoreCheckpointRepository
    .upsertBatch(
      season,
      eventId,
      { scopeType: 'CLASSIC_LEAGUE', scopeId: leagueId },
      fetchedRows.map((row) => toManagerScoreCheckpoint(row)),
    )
    .catch((error) =>
      logWarn('Official manager checkpoint write failed', {
        eventId,
        leagueId,
        error: error instanceof Error ? error.message : 'unknown',
      }),
    );
  const durableRows = await managerScoreCheckpointRepository
    .findByScopeAndEntryIds(
      season,
      eventId,
      { scopeType: 'CLASSIC_LEAGUE', scopeId: leagueId },
      fetchedRows.map((row) => row.entryId),
    )
    .catch((error) => {
      logWarn('Official classic manager checkpoint verification read failed', {
        eventId,
        leagueId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return [];
    });
  mergeLatestRows(
    rows,
    new Map(
      durableRows.map((row) => [row.entryId, fromManagerScoreCheckpoint(row, season.seasonCode)]),
    ),
  );
  logDebug('Official classic manager live refresh completed', {
    eventId,
    leagueId,
    requested: targetIds.size,
    fetched: fetchedRows.length,
    partial: refreshErrorCode !== null,
  });
  return {
    complete:
      refreshErrorCode === null &&
      (exhausted || foundEntryIds.size >= targetIds.size || nextPage > MAX_STANDINGS_PAGES),
    nextPage,
    errorCode: refreshErrorCode,
    refreshedEntryIds: fetchedRows.map((row) => row.entryId),
  };
};

const classicStandingNeedsOverallRank = (row: CachedRow | undefined): boolean =>
  row?.source === 'FPL_CLASSIC_STANDINGS' &&
  (typeof row.overallRank !== 'number' ||
    !Number.isSafeInteger(row.overallRank) ||
    row.overallRank <= 0);

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
  let rows = new Map<number, CachedRow>();
  try {
    rows = await readCachedRows(redis, season.seasonCode, input.eventId, scope, uniqueEntryIds);
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
  mergeLatestRows(
    rows,
    new Map(
      checkpoints.map((checkpoint) => [
        checkpoint.entryId,
        fromManagerScoreCheckpoint(checkpoint, season.seasonCode),
      ]),
    ),
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
    uniqueEntryIds.some((entryId) => classicStandingNeedsOverallRank(rows.get(entryId)));
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
      refreshErrorCode = await refreshEntrySummaries(
        season,
        input.eventId,
        foregroundRefreshTargets,
        rows,
        redis,
        entryScope,
        { maxFetches: MAX_FOREGROUND_SUMMARY_FETCHES },
      );
    }
    const pending = staleOrMissing.filter(
      (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
    );
    if (pending.length > 0) {
      const backgroundKey = `h2h:${season.seasonCode}:${input.eventId}:${input.tournamentId}:${pending
        .slice()
        .sort((left, right) => left - right)
        .join(',')}`;
      const capturedBackgroundRows = new Map(rows);
      scheduleBackgroundRefresh(backgroundKey, async () => {
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
      const foregroundRefresh = await runClassicStandingsRefresh(
        redis,
        classicRefreshKey,
        async () => {
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
          const rankTargets = uniqueEntryIds
            .filter(
              (entryId) =>
                rankCandidateIds.has(entryId) && classicStandingNeedsOverallRank(rows.get(entryId)),
            )
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
                  { force: true, preserveClassicStanding: true },
                )
              : null;
          return { standings: nextStandings, rankError };
        },
        'foreground',
      );
      standings = foregroundRefresh.standings;
      refreshErrorCode = standings.errorCode ?? foregroundRefresh.rankError;
    } else {
      refreshErrorCode = standings.errorCode;
    }

    let pendingCold = foregroundRefreshTargets.filter(
      (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
    );
    const foregroundFallbackPlan = planClassicManagerFallback(pendingCold, [], standings.complete);
    if (foregroundFallbackPlan.foregroundSummaryEntryIds.length > 0) {
      const summaryError = await runClassicStandingsRefresh(
        redis,
        classicRefreshKey,
        async () => {
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
            ? refreshEntrySummaries(season, input.eventId, summaryTargets, rows, redis, scope)
            : null;
        },
        'foreground',
      );
      refreshErrorCode = refreshErrorCode ?? summaryError;
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
    const deferredForegroundRankTargets = standings.refreshedEntryIds.slice(
      MAX_FOREGROUND_OVERALL_RANK_FETCHES,
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
    if (backgroundEntryIds.length > 0) {
      const backgroundKey = managerLiveBackgroundRefreshKey(
        `classic:${season.seasonCode}:${input.eventId}:${classicLeagueId}`,
        backgroundEntryIds,
      );
      const capturedBackgroundRows = new Map(rows);
      scheduleBackgroundRefresh(backgroundKey, async () => {
        let backgroundRows = new Map(capturedBackgroundRows);
        let backgroundResult: Awaited<ReturnType<typeof refreshClassicStandings>> = {
          complete: standings.complete,
          nextPage: standings.nextPage,
          errorCode: null,
          refreshedEntryIds: [],
        };
        if (backgroundPlan.backgroundStandingsEntryIds.length > 0) {
          backgroundResult = await runManagerStandingsPageSequence(1, MAX_STANDINGS_PAGES, (page) =>
            runClassicStandingsRefresh(
              redis,
              classicRefreshKey,
              async () => {
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
        const refreshedStandingsIds = new Set(backgroundResult.refreshedEntryIds);
        const rankOnlyEntryIds = new Set(rankOnlyTargets);
        const backgroundRankTargets = Array.from(
          new Set([...rankOnlyTargets, ...backgroundResult.refreshedEntryIds]),
        ).filter((entryId) => {
          const row = backgroundRows.get(entryId);
          return (
            row?.source === 'FPL_CLASSIC_STANDINGS' &&
            classicStandingNeedsOverallRank(row) &&
            (refreshedStandingsIds.has(entryId) || (rankOnlyEntryIds.has(entryId) && isFresh(row)))
          );
        });

        // Hold the league lane for one four-entry upstream wave at a time.
        // Foreground misses can therefore jump ahead between background waves,
        // while every merge still observes the latest serialized standings row.
        for (const batch of managerSummaryFetchBatches(backgroundRankTargets)) {
          await runClassicStandingsRefresh(
            redis,
            classicRefreshKey,
            async () => {
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
                  classicStandingNeedsOverallRank(row) &&
                  (refreshedStandingsIds.has(entryId) ||
                    (rankOnlyEntryIds.has(entryId) && isFresh(row)))
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
                  { force: true, priority: 'background', preserveClassicStanding: true },
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
            async () => {
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
                  { priority: 'background' },
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
      refreshErrorCode = await refreshEntrySummaries(
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
    }
    const pending = staleOrMissing.filter(
      (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
    );
    if (pending.length > 0) {
      const backgroundKey = managerLiveBackgroundRefreshKey(
        `summary:${season.seasonCode}:${input.eventId}`,
        pending,
      );
      const capturedBackgroundRows = new Map(rows);
      scheduleBackgroundRefresh(backgroundKey, async () => {
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
