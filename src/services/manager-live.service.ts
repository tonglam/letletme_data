import { createHash } from 'node:crypto';

import type Redis from 'ioredis';

import { fplClient, type RawFPLLeagueStandingsResponse } from '../clients/fpl';
import { redisSingleton } from '../cache/singleton';
import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { FPLClientError, ValidationError } from '../utils/errors';
import { logDebug, logWarn } from '../utils/logger';

const CACHE_TTL_SECONDS = 48 * 60 * 60;
// Refresh at 30s while an event is active, but keep a successfully published
// official row fresh for at least three refresh cycles. This prevents a
// transient refresh miss from being presented as stale immediately.
const REFRESH_SECONDS = 30;
const STALE_SECONDS = Math.max(90, 3 * REFRESH_SECONDS);
const MAX_STANDINGS_PAGES = 20;
const MAX_FOREGROUND_STANDINGS_PAGES = 4;
const MAX_FOREGROUND_SUMMARY_FETCHES = 4;

export type ManagerLiveSource = 'FPL_ENTRY_SUMMARY' | 'FPL_CLASSIC_STANDINGS';
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

const cacheKey = (season: string, eventId: number): string =>
  `OfficialManagerLive:${season}:${eventId}`;
const metaCacheKey = (season: string, eventId: number): string =>
  `OfficialManagerLiveMeta:${season}:${eventId}`;

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
  return `${row.checkedAt}:${digest}`;
};

const withRevision = (row: Omit<ManagerLiveScoreRow, 'revision'>): ManagerLiveScoreRow => ({
  ...row,
  revision: stableRevision(row),
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
      (row.source !== 'FPL_ENTRY_SUMMARY' && row.source !== 'FPL_CLASSIC_STANDINGS')
    ) {
      return null;
    }
    if (
      typeof row.staleAt !== 'string' ||
      (row.netEventPoints !== undefined && row.netEventPoints !== null && typeof row.netEventPoints !== 'number') ||
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
  redis: Redis,
  season: string,
  eventId: number,
  entryIds: readonly number[],
): Promise<Map<number, CachedRow>> => {
  if (entryIds.length === 0) return new Map();
  const values = await redis.hmget(cacheKey(season, eventId), ...entryIds.map(String));
  const rows = new Map<number, CachedRow>();
  for (let index = 0; index < entryIds.length; index += 1) {
    const row = parseCachedRow(values[index] ?? null);
    if (row) rows.set(entryIds[index], row);
  }
  return rows;
};

const writeRows = async (
  redis: Redis,
  season: string,
  eventId: number,
  rows: readonly ManagerLiveScoreRow[],
  metadata?: Record<string, unknown>,
  metadataField = 'publication',
): Promise<void> => {
  if (rows.length === 0 && !metadata) return;
  const key = cacheKey(season, eventId);
  // Use a Redis transaction so a row publication and its metadata become
  // visible together; readers never observe a half-published page.
  const pipeline = redis.multi();
  for (const row of rows) pipeline.hset(key, String(row.entryId), JSON.stringify(row));
  if (rows.length > 0) pipeline.expire(key, CACHE_TTL_SECONDS);
  if (metadata) {
    const metaKey = metaCacheKey(season, eventId);
    pipeline.hset(metaKey, metadataField, JSON.stringify(metadata));
    pipeline.expire(metaKey, CACHE_TTL_SECONDS);
  }
  await pipeline.exec();
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
      if (typeof entryId !== 'number' || !Number.isSafeInteger(entryId) || entryId <= 0) return null;
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

const isFresh = (row: CachedRow, now = Date.now()): boolean => ageSeconds(row.checkedAt, now) <= REFRESH_SECONDS;
const isWithinStaleWindow = (row: CachedRow, now = Date.now()): boolean =>
  ageSeconds(row.checkedAt, now) <= STALE_SECONDS;

const managerLiveBackgroundInFlight = new Map<string, Promise<void>>();

const scheduleBackgroundRefresh = (key: string, task: () => Promise<void>): void => {
  if (managerLiveBackgroundInFlight.has(key)) return;
  const promise = task()
    .catch((error) => {
      logWarn('Official manager live background refresh failed', {
        key,
        error: error instanceof FPLClientError ? error.code ?? error.status : 'unknown',
      });
    })
    .finally(() => {
      managerLiveBackgroundInFlight.delete(key);
    });
  managerLiveBackgroundInFlight.set(key, promise);
};

const refreshEntrySummaries = async (
  season: string,
  eventId: number,
  entryIds: readonly number[],
  rows: Map<number, CachedRow>,
  redis: Redis,
  options: { maxFetches?: number } = {},
): Promise<'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null> => {
  const targets = entryIds
    .filter((entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!))
    .slice(0, options.maxFetches ?? Number.POSITIVE_INFINITY);
  if (targets.length === 0) return null;

  const checkedAt = nowIso();
  const refreshed: ManagerLiveScoreRow[] = [];
  let refreshErrorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null = null;
  await Promise.all(
    targets.map(async (entryId) => {
      try {
        const summary = await fplClient.getEntrySummary(entryId);
        refreshed.push(toEntrySummaryRow(season, eventId, entryId, summary, checkedAt));
      } catch (error) {
        if (error instanceof FPLClientError && error.status === 429) {
          refreshErrorCode = 'UPSTREAM_RATE_LIMITED';
        } else {
          refreshErrorCode = refreshErrorCode ?? 'UPSTREAM_UNAVAILABLE';
        }
        logWarn('Official manager entry summary refresh failed', {
          entryId,
          eventId,
          error: error instanceof FPLClientError ? error.code ?? error.status : 'unknown',
        });
      }
    }),
  );
  await writeRows(redis, season, eventId, refreshed, refreshed.length > 0 ? {
      season,
      eventId,
      source: 'FPL_ENTRY_SUMMARY',
      rowCount: refreshed.length,
      checkedAt,
      revision: refreshed[0]?.revision ?? null,
      nextRefreshAt: new Date(Date.now() + REFRESH_SECONDS * 1000).toISOString(),
    } : undefined, 'entry-summary');
  for (const row of refreshed) rows.set(row.entryId, row);
  return refreshErrorCode;
};

const refreshClassicStandings = async (
  season: string,
  eventId: number,
  leagueId: number,
  targetIds: ReadonlySet<number>,
  rows: Map<number, CachedRow>,
  redis: Redis,
  options: { startPage?: number; maxPages?: number } = {},
): Promise<{
  complete: boolean;
  nextPage: number;
  errorCode: 'UPSTREAM_RATE_LIMITED' | 'UPSTREAM_UNAVAILABLE' | null;
}> => {
  const checkedAt = nowIso();
  const fetchedRows: ManagerLiveScoreRow[] = [];
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
      nextPage = page + 1;
      const response = await fplClient.getLeagueClassicStandings(leagueId, page);
      const pageRows = toClassicRows(season, eventId, response, checkedAt);
      for (const row of pageRows) {
        if (!targetIds.has(row.entryId)) continue;
        if (!rows.has(row.entryId) || !isFresh(rows.get(row.entryId)!)) found += 1;
        fetchedRows.push(row);
        rows.set(row.entryId, row);
      }
      if (!response.standings.has_next) {
        exhausted = true;
        break;
      }
    }
    await writeRows(redis, season, eventId, fetchedRows, fetchedRows.length > 0 ? {
        season,
        eventId,
        source: 'FPL_CLASSIC_STANDINGS',
        leagueId,
        rowCount: fetchedRows.length,
        checkedAt,
        revision: fetchedRows[0]?.revision ?? null,
        nextRefreshAt: new Date(Date.now() + REFRESH_SECONDS * 1000).toISOString(),
      } : undefined, `classic:${leagueId}:pages:${startPage}-${Math.max(startPage, nextPage - 1)}`);
    logDebug('Official classic manager live refresh completed', {
      eventId,
      leagueId,
      requested: targetIds.size,
      fetched: fetchedRows.length,
    });
    return {
      complete: exhausted || found >= targetIds.size || nextPage > MAX_STANDINGS_PAGES,
      nextPage,
      errorCode: null,
    };
  } catch (error) {
    refreshErrorCode = error instanceof FPLClientError && error.status === 429
      ? 'UPSTREAM_RATE_LIMITED'
      : 'UPSTREAM_UNAVAILABLE';
    logWarn('Official classic manager standings refresh failed', {
      eventId,
      leagueId,
      error: error instanceof FPLClientError ? error.code ?? error.status : 'unknown',
    });
    return { complete: false, nextPage, errorCode: refreshErrorCode };
  }
};

const nextRefresh = (eventFinished: boolean): string =>
  new Date(Date.now() + (eventFinished ? 60_000 : 30_000)).toISOString();

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
    throw new ValidationError('Event does not belong to the active season.', 'MANAGER_LIVE_EVENT_INVALID');
  }

  const redis = await redisSingleton.getClient();
  const rows = await readCachedRows(redis, season.seasonCode, input.eventId, uniqueEntryIds);
  const staleOrMissing = uniqueEntryIds.filter(
    (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
  );
  let errorCode: ManagerLiveResolveResult['errorCode'] = null;
  let refreshErrorCode: Exclude<ManagerLiveResolveResult['errorCode'], 'UNSUPPORTED_H2H_LIVE' | null> | null = null;

  if (input.tournamentId !== undefined) {
    const tournament = await tournamentInfoRepository.findById(season, input.tournamentId);
    if (!tournament) {
      throw new ValidationError('Tournament does not belong to the active season.', 'MANAGER_LIVE_TOURNAMENT_INVALID');
    }
    const roster = new Set(await tournamentEntryRepository.findEntryIdsByTournamentId(season, input.tournamentId));
    if (uniqueEntryIds.some((entryId) => !roster.has(entryId))) {
      throw new ValidationError('Entry is not a member of the tournament.', 'MANAGER_LIVE_ENTRY_NOT_IN_TOURNAMENT');
    }
    if (tournament.leagueType === 'h2h') {
      errorCode = 'UNSUPPORTED_H2H_LIVE';
    } else if (staleOrMissing.length > 0) {
      const standings = await refreshClassicStandings(
        season.seasonCode,
        input.eventId,
        tournament.leagueId,
        new Set(staleOrMissing),
        rows,
        redis,
      );
      refreshErrorCode = standings.errorCode;
      const pending = staleOrMissing.filter(
        (entryId) => !rows.has(entryId) || !isFresh(rows.get(entryId)!),
      );
      if (pending.length > 0 && !standings.complete) {
        const backgroundKey = `classic:${season.seasonCode}:${input.eventId}:${tournament.leagueId}`;
        scheduleBackgroundRefresh(backgroundKey, async () => {
          const backgroundRows = await readCachedRows(
            redis,
            season.seasonCode,
            input.eventId,
            pending,
          );
          const backgroundResult = await refreshClassicStandings(
            season.seasonCode,
            input.eventId,
            tournament.leagueId,
            new Set(pending),
            backgroundRows,
            redis,
            { startPage: standings.nextPage, maxPages: MAX_STANDINGS_PAGES },
          );
          logDebug('Official classic manager background refresh completed', {
            eventId: input.eventId,
            leagueId: tournament.leagueId,
            remaining: pending.length,
            complete: backgroundResult.complete,
          });
        });
      }
    }
  }

  if (!errorCode && input.tournamentId === undefined && staleOrMissing.length > 0) {
    const summaryTargets = staleOrMissing;
    refreshErrorCode = await refreshEntrySummaries(season.seasonCode, input.eventId, summaryTargets, rows, redis, {
      maxFetches: MAX_FOREGROUND_SUMMARY_FETCHES,
    });
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
          pending,
        );
        await refreshEntrySummaries(
          season.seasonCode,
          input.eventId,
          pending,
          backgroundRows,
          redis,
        );
      });
    }
  }

	const now = Date.now();
	// Never reuse an event-scoped entry/classic row for an H2H board. H2H stays
	// on its legacy adapter until FPL publishes a usable live H2H contract.
	const resolvedRows = errorCode === 'UNSUPPORTED_H2H_LIVE'
		? []
		: uniqueEntryIds
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
