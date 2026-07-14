/**
 * Job Condition Helpers
 *
 * Common utility functions for checking job execution conditions
 * Used by Elysia cron jobs and other scheduling logic
 */

import type { Event, Fixture } from '../types';
import { fixtureRepository } from '../repositories/fixtures';

const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const FINISH_FLAG_GRACE_MS = 6 * 60 * 60 * 1000;
const SEASON_WINDOW_CACHE_TTL_MS = 10 * 60 * 1000;

type SeasonWindow = {
  startDayMs: number;
  endDayMs: number;
  loadedAtMs: number;
};

let cachedSeasonWindow: SeasonWindow | null = null;

function toUtcDayStartMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
}

function toUtcDayEndMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999);
}

function extractKickoffs(fixtures: Fixture[]): Date[] {
  return fixtures
    .map((fixture) => fixture.kickoffTime)
    .filter((kickoffTime): kickoffTime is Date => Boolean(kickoffTime));
}

async function loadSeasonWindow(now: Date): Promise<SeasonWindow | null> {
  if (
    cachedSeasonWindow &&
    now.getTime() - cachedSeasonWindow.loadedAtMs < SEASON_WINDOW_CACHE_TTL_MS
  ) {
    return cachedSeasonWindow;
  }

  const [gw1Fixtures, gw38Fixtures] = await Promise.all([
    fixtureRepository.findByEvent(1),
    fixtureRepository.findByEvent(38),
  ]);
  const gw1Kickoffs = extractKickoffs(gw1Fixtures);
  const gw38Kickoffs = extractKickoffs(gw38Fixtures);
  if (gw1Kickoffs.length === 0 || gw38Kickoffs.length === 0) {
    cachedSeasonWindow = null;
    return null;
  }

  const firstKickoffMs = Math.min(...gw1Kickoffs.map((kickoff) => kickoff.getTime()));
  const lastKickoffMs = Math.max(...gw38Kickoffs.map((kickoff) => kickoff.getTime()));
  const startDayMs = toUtcDayStartMs(new Date(firstKickoffMs));
  const endDayMs = toUtcDayEndMs(new Date(lastKickoffMs));

  const resolved: SeasonWindow = {
    startDayMs,
    endDayMs,
    loadedAtMs: now.getTime(),
  };
  cachedSeasonWindow = resolved;
  return resolved;
}

/**
 * Check if current date is inside active FPL season window:
 * from first day of GW1 to last day of GW38 (UTC day boundaries).
 */
export async function isFPLSeason(date = new Date()): Promise<boolean> {
  const seasonWindow = await loadSeasonWindow(date);
  if (!seasonWindow) {
    return false;
  }

  const nowMs = date.getTime();
  return nowMs >= seasonWindow.startDayMs && nowMs <= seasonWindow.endDayMs;
}

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getMatchWindow(fixtures: Fixture[]) {
  const kickoffTimes = fixtures
    .map((fixture) => fixture.kickoffTime)
    .filter((kickoffTime): kickoffTime is Date => Boolean(kickoffTime));

  if (kickoffTimes.length === 0) {
    return { start: null as Date | null, end: null as Date | null, matchDates: new Set<string>() };
  }

  const timestamps = kickoffTimes.map((kickoff) => kickoff.getTime());
  const start = new Date(Math.min(...timestamps));
  const end = new Date(Math.max(...timestamps) + MATCH_WINDOW_MS);
  const matchDates = new Set(kickoffTimes.map((kickoff) => toUtcDateString(kickoff)));

  return { start, end, matchDates };
}

function getMatchIntervals(fixtures: Fixture[]) {
  return fixtures
    .filter((fixture): fixture is Fixture & { kickoffTime: Date } => Boolean(fixture.kickoffTime))
    .map((fixture) => {
      const kickoff = fixture.kickoffTime;
      const startMs = kickoff.getTime();
      return {
        fixture,
        startMs,
        endMs: startMs + MATCH_WINDOW_MS,
        hardEndMs: startMs + FINISH_FLAG_GRACE_MS,
      };
    });
}

export function isMatchDay(event: Event, fixtures: Fixture[], date = new Date()): boolean {
  if (event.finished) {
    return false;
  }

  const { matchDates } = getMatchWindow(fixtures);
  if (matchDates.size === 0) {
    return false;
  }

  return matchDates.has(toUtcDateString(date));
}

export function isAfterMatchDay(event: Event, fixtures: Fixture[], date = new Date()): boolean {
  if (event.finished) {
    return true;
  }

  const { end } = getMatchWindow(fixtures);
  if (!end) {
    return false;
  }

  return date.getTime() > end.getTime();
}

export function isMatchDayTime(event: Event, fixtures: Fixture[], date = new Date()): boolean {
  if (event.finished) {
    return false;
  }

  const intervals = getMatchIntervals(fixtures);
  if (intervals.length === 0) {
    return false;
  }

  const now = date.getTime();
  return intervals.some((interval) => {
    const { fixture } = interval;
    const withinNominalWindow = now >= interval.startMs && now <= interval.endMs;
    if (withinNominalWindow) {
      return true;
    }

    // FPL finish flags can lag; keep window open while a started fixture is
    // not marked finished, but cap it with a hard timeout.
    const startedButUnfinished = fixture.started === true && fixture.finished !== true;
    return startedButUnfinished && now <= interval.hardEndMs;
  });
}

export function isSelectTime(event: Event, fixtures: Fixture[], date = new Date()): boolean {
  if (!isMatchDay(event, fixtures, date)) {
    return false;
  }

  const rawDeadline = event.deadlineTime;
  if (!rawDeadline) {
    return false;
  }

  const deadlineMs = new Date(rawDeadline).getTime();

  if (Number.isNaN(deadlineMs)) {
    return false;
  }

  const windowStart = deadlineMs + 30 * 60 * 1000;
  const windowEnd = deadlineMs + 90 * 60 * 1000;

  const now = date.getTime();
  return now >= windowStart && now <= windowEnd;
}

/**
 * Get current FPL season in format YYMM (e.g., 2526 for 2025-26 season)
 * Premier League starts in August each year
 */
export function getCurrentSeason(date = new Date()): string {
  const month = date.getMonth() + 1; // 1-based month
  const year = date.getFullYear();

  if (month >= 8) {
    // August onwards - new season starts (Aug 2025 -> 2526)
    const currentYearShort = year.toString().slice(-2);
    const nextYearShort = (year + 1).toString().slice(-2);
    return `${currentYearShort}${nextYearShort}`;
  } else {
    // July or earlier - previous season continues (Jul 2025 -> 2425)
    const prevYearShort = (year - 1).toString().slice(-2);
    const currentYearShort = year.toString().slice(-2);
    return `${prevYearShort}${currentYearShort}`;
  }
}

/**
 * Estimate current gameweek (rough calculation)
 */
export function getCurrentGameweek(date = new Date()): number {
  const seasonStart = new Date(date.getFullYear(), 7, 1); // August 1st
  if (date < seasonStart) {
    // Previous season
    const prevSeasonStart = new Date(date.getFullYear() - 1, 7, 1);
    const weeksDiff = Math.floor(
      (date.getTime() - prevSeasonStart.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
    return Math.min(Math.max(weeksDiff, 1), 38);
  } else {
    // Current season
    const weeksDiff = Math.floor(
      (date.getTime() - seasonStart.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
    return Math.min(Math.max(weeksDiff + 1, 1), 38);
  }
}
