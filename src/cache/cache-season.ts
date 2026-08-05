import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';

import { getDb, type DbHandle, type DbOrTransaction } from '../db/singleton';
import { logDebug, logError, logInfo } from '../utils/logger';
import { redisSingleton } from './singleton';

import type { Event, Fixture, RawFPLEvent, RawFPLFixture } from '../types';

export const ACTIVE_SEASON_KEY = 'Season:active';

// "LLSN" as a signed-safe 32-bit advisory-lock namespace. Live snapshot and
// fixture writers hold the shared form while a season rollover holds the
// exclusive form. Shared locks preserve cross-event parallelism; rollover
// cannot change Redis truth or delete old-season keys until every in-flight
// live/fixture operation has finished its PostgreSQL and Redis commits.
export const ACTIVE_SEASON_LOCK_NAMESPACE = 0x4c4c534e;
export const ACTIVE_SEASON_LOCK_ID = 0;

export const DEFAULT_ACTIVE_SEASON_MEMO_TTL_MS = 5_000;

// In-process memo for Season:active. Every season-scoped cache read resolves
// the active season first, making this the hottest read in the system; a ~5s
// memo halves those round trips while a rollover (once a year) still
// propagates within seconds. Only valid Redis values are memoized — read
// failures keep failing fast per FP-03. Tests may override the TTL via
// ACTIVE_SEASON_MEMO_TTL_MS and reset via resetActiveSeasonMemo().
let activeSeasonMemo: { season: string; expiresAt: number } | null = null;

function getActiveSeasonMemoTtlMs(): number {
  const raw = process.env.ACTIVE_SEASON_MEMO_TTL_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_ACTIVE_SEASON_MEMO_TTL_MS;
}

function memoizeActiveSeason(season: string): void {
  activeSeasonMemo = { season, expiresAt: Date.now() + getActiveSeasonMemoTtlMs() };
}

/** Called only after the complete core snapshot transaction publishes Season:active. */
export function rememberCoreSnapshotActiveSeason(season: string): void {
  if (!isValidSeason(season)) throw new Error(`Invalid active cache season: ${season}`);
  memoizeActiveSeason(season);
}

function readActiveSeasonMemo(): string | null {
  if (activeSeasonMemo && activeSeasonMemo.expiresAt > Date.now()) {
    return activeSeasonMemo.season;
  }
  activeSeasonMemo = null;
  return null;
}

/** Test hook: drop the in-process memo so each test starts cold. */
export function resetActiveSeasonMemo(): void {
  activeSeasonMemo = null;
}

export const SEASON_CACHE_PREFIXES = [
  'Event',
  'Team',
  'Player',
  'Phase',
  'Fixtures',
  'FixturesByTeam',
  'EventLive',
  'EventLiveSummary',
  'EventLiveExplain',
  'EventLiveExplainV2',
  'LiveFixture',
  'LiveFixtureV2',
  'LiveBonus',
  'LiveBonusV2',
  'LiveSnapshotMeta',
  'EventOverallResult',
  'EntryInfo',
  'PlayerStat',
] as const;

type EventLike = Pick<RawFPLEvent, 'id' | 'deadline_time'> | Pick<Event, 'id' | 'deadlineTime'>;

type FixtureLike =
  | Pick<RawFPLFixture, 'event' | 'kickoff_time'>
  | Pick<Fixture, 'event' | 'kickoffTime'>;

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    if (found.length > 0) {
      keys.push(...found);
    }
    cursor = nextCursor;
  } while (cursor !== '0');

  return keys;
}

function isValidSeason(season: string | null): season is string {
  return season !== null && /^\d{4}$/.test(season);
}

export function seasonFromStartYear(startYear: number): string {
  const currentYearShort = startYear.toString().slice(-2);
  const nextYearShort = (startYear + 1).toString().slice(-2);
  return `${currentYearShort}${nextYearShort}`;
}

export function isNewerSeason(candidate: string, current: string | null): boolean {
  if (!isValidSeason(candidate)) {
    return false;
  }
  if (!isValidSeason(current)) {
    return true;
  }
  return Number(candidate) > Number(current);
}

function getDeadline(event: EventLike): string | null {
  if ('deadline_time' in event) {
    return event.deadline_time;
  }
  return event.deadlineTime;
}

function getKickoff(fixture: FixtureLike): string | Date | null {
  if ('kickoff_time' in fixture) {
    return fixture.kickoff_time;
  }
  return fixture.kickoffTime;
}

function getUtcYear(value: string | Date | null): number | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return null;
  }
  return date.getUTCFullYear();
}

export function deriveSeasonFromEvents(events: readonly EventLike[]): string | null {
  const gw1 = events.find((event) => event.id === 1);
  const startYear = gw1 ? getUtcYear(getDeadline(gw1)) : null;
  return startYear === null ? null : seasonFromStartYear(startYear);
}

export function deriveSeasonFromFixtures(fixtures: readonly FixtureLike[]): string | null {
  const gw1Kickoffs = fixtures
    .filter((fixture) => fixture.event === 1)
    .map((fixture) => getKickoff(fixture))
    .map(getUtcYear)
    .filter((year): year is number => year !== null);

  if (gw1Kickoffs.length === 0) {
    return null;
  }

  return seasonFromStartYear(Math.min(...gw1Kickoffs));
}

export function resolveFixtureRepairSeason(
  fixtures: readonly FixtureLike[],
  authoritativeSeason?: string | null,
): string | null {
  const fixtureSeason = deriveSeasonFromFixtures(fixtures);
  if (authoritativeSeason === undefined) return fixtureSeason;
  if (!isValidSeason(authoritativeSeason)) return null;
  if (fixtureSeason && fixtureSeason !== authoritativeSeason) return null;
  return authoritativeSeason;
}

export async function getActiveCacheSeason(): Promise<string> {
  const memoized = readActiveSeasonMemo();
  if (memoized) {
    return memoized;
  }

  const activeSeason = await getActiveCacheSeasonUncached();
  memoizeActiveSeason(activeSeason);
  return activeSeason;
}

/**
 * Read Redis truth without consulting or refreshing the process memo. Mutation
 * fences use this during the once-a-year rollover so an old worker cannot
 * publish or persist under a season that another process already retired.
 */
export async function getActiveCacheSeasonUncached(): Promise<string> {
  try {
    const redis = await redisSingleton.getClient();
    const activeSeason = await redis.get(ACTIVE_SEASON_KEY);
    if (isValidSeason(activeSeason)) {
      return activeSeason;
    }
  } catch (error) {
    logError('Failed to read active cache season', error);
    throw error;
  }

  throw new Error(`${ACTIVE_SEASON_KEY} is missing or malformed`);
}

/**
 * Pin the active season for the remainder of an existing PostgreSQL
 * transaction. Live publishers take event locks first. Fixture discovery may
 * take this shared lock before its dynamically discovered event locks; shared
 * readers do not conflict, and the exclusive rollover path takes no event
 * lock, so that ordering cannot form an advisory-lock cycle.
 */
export async function acquireActiveSeasonReadFence(tx: DbOrTransaction): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(${ACTIVE_SEASON_LOCK_NAMESPACE}, ${ACTIVE_SEASON_LOCK_ID})`,
  );
}

export async function acquireActiveSeasonWriteFence(tx: DbOrTransaction): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${ACTIVE_SEASON_LOCK_NAMESPACE}, ${ACTIVE_SEASON_LOCK_ID})`,
  );
}

export async function withActiveSeasonWriteFence<T>(
  operation: () => Promise<T>,
  dbInstance?: DbHandle,
): Promise<T> {
  const db = dbInstance ?? (await getDb());
  return db.transaction(async (tx) => {
    await acquireActiveSeasonWriteFence(tx);
    return operation();
  });
}

export async function readStoredActiveCacheSeason(redisClient?: Redis): Promise<string | null> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  const current = await redis.get(ACTIVE_SEASON_KEY);
  return isValidSeason(current) ? current : null;
}

export async function clearStaleSeasonCache(
  activeSeason: string,
  prefixes: readonly string[] = SEASON_CACHE_PREFIXES,
  redisClient?: Redis,
): Promise<void> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  const staleKeys: string[] = [];

  for (const prefix of prefixes) {
    const keys = await scanKeys(redis, `${prefix}:*`);
    const currentSeasonPrefix = `${prefix}:${activeSeason}`;
    staleKeys.push(
      ...keys.filter(
        (key) => key !== currentSeasonPrefix && !key.startsWith(`${currentSeasonPrefix}:`),
      ),
    );
  }

  if (staleKeys.length === 0) {
    logDebug('No stale season cache keys to clear', { activeSeason, prefixes });
    return;
  }

  await redis.del(...staleKeys);
  logInfo('Cleared stale season cache keys', {
    activeSeason,
    prefixes,
    count: staleKeys.length,
  });
}

export async function finalizeSeasonCacheWrite(
  season: string,
  _prefixes: readonly string[],
): Promise<void> {
  const activeSeason = await readStoredActiveCacheSeason();
  if (activeSeason !== season) {
    throw new Error(
      `Core snapshot required before publishing season cache data (candidate=${season})`,
    );
  }
}
