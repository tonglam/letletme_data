import type { Redis } from 'ioredis';

import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError, logInfo } from '../utils/logger';
import { redisSingleton } from './singleton';

import type { Event, Fixture, RawFPLEvent, RawFPLFixture } from '../types';

export const ACTIVE_SEASON_KEY = 'Season:active';

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
  try {
    const redis = await redisSingleton.getClient();
    const activeSeason = await redis.get(ACTIVE_SEASON_KEY);
    if (isValidSeason(activeSeason)) {
      return activeSeason;
    }
  } catch (error) {
    logError('Failed to read active cache season; falling back to calendar season', error);
  }

  return getCurrentSeason();
}

export async function setActiveCacheSeason(season: string): Promise<void> {
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
    return;
  }

  await redis.set(ACTIVE_SEASON_KEY, season);
  logInfo('Active cache season updated', { season, previous: current });
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
  await setActiveCacheSeason(season);
  await clearStaleSeasonCache(season, prefixes);
}
