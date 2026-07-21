import type { Redis } from 'ioredis';

import { logDebug, logError, logInfo } from '../utils/logger';
import { redisSingleton } from './singleton';

import type { Event, Fixture, RawFPLEvent, RawFPLFixture } from '../types';

export const ACTIVE_SEASON_KEY = 'Season:active';

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

const SEASON_CACHE_PREFIXES = ['Event', 'Team', 'Player', 'Phase', 'Fixtures', 'FixturesByTeam'];

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

export async function getActiveCacheSeason(): Promise<string> {
  const memoized = readActiveSeasonMemo();
  if (memoized) {
    return memoized;
  }

  try {
    const redis = await redisSingleton.getClient();
    const activeSeason = await redis.get(ACTIVE_SEASON_KEY);
    if (isValidSeason(activeSeason)) {
      memoizeActiveSeason(activeSeason);
      return activeSeason;
    }
  } catch (error) {
    logError('Failed to read active cache season', error);
    throw error;
  }

  throw new Error(`${ACTIVE_SEASON_KEY} is missing or malformed`);
}

export async function setActiveCacheSeason(season: string): Promise<boolean> {
  if (!isValidSeason(season)) {
    throw new Error(`Invalid active cache season: ${season}`);
  }

  const redis = await redisSingleton.getClient();
  const current = await redis.get(ACTIVE_SEASON_KEY);
  if (!isNewerSeason(season, current)) {
    logDebug('Skipping active cache season update; candidate is not newer', {
      candidate: season,
      current,
    });
    // Re-arm the memo from Redis truth so a skipped update still converges
    // the memo (e.g. another writer advanced the key while our memo was cold).
    if (isValidSeason(current)) {
      memoizeActiveSeason(current);
    }
    return false;
  }

  await redis.set(ACTIVE_SEASON_KEY, season);
  memoizeActiveSeason(season);
  logInfo('Active cache season updated', { season, previous: current });
  return true;
}

export async function clearStaleSeasonCache(
  activeSeason: string,
  prefixes: readonly string[] = SEASON_CACHE_PREFIXES,
): Promise<void> {
  const redis = await redisSingleton.getClient();
  const staleKeys: string[] = [];

  for (const prefix of prefixes) {
    const keys = await scanKeys(redis, `${prefix}:*`);
    staleKeys.push(...keys.filter((key) => !key.startsWith(`${prefix}:${activeSeason}`)));
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
  prefixes: readonly string[],
): Promise<void> {
  const changed = await setActiveCacheSeason(season);
  if (!changed) {
    return;
  }
  await clearStaleSeasonCache(season, prefixes);
}
