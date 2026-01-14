/**
 * Job Condition Helpers
 *
 * Common utility functions for checking job execution conditions
 * Used by Elysia cron jobs and other scheduling logic
 */

import type { Event, Fixture } from '../types';
import { logInfo } from './logger';

/**
 * Check if it's currently FPL season (August to May)
 */
export function isFPLSeason(date = new Date()): boolean {
  const month = date.getMonth() + 1; // 1-based month
  return month >= 8 || month <= 5; // Aug-May
}

/**
 * Check if it's currently weekend (Saturday or Sunday)
 */
export function isWeekend(date = new Date()): boolean {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday or Saturday
}

/**
 * Check if it's during match hours (6 AM to 11 PM)
 */
export function isMatchHours(date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= 6 && hour <= 23;
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
  const end = new Date(Math.max(...timestamps) + 2 * 60 * 60 * 1000);
  const matchDates = new Set(kickoffTimes.map((kickoff) => toUtcDateString(kickoff)));

  return { start, end, matchDates };
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

  const { start, end } = getMatchWindow(fixtures);
  if (!start || !end) {
    return false;
  }

  const now = date.getTime();
  return now >= start.getTime() && now <= end.getTime();
}

export function isSelectTime(event: Event, fixtures: Fixture[], date = new Date()): boolean {
  if (!isMatchDay(event, fixtures, date)) {
    return false;
  }

  if (!event.deadlineTime) {
    return false;
  }

  const deadlineTime = event.deadlineTime.getTime();
  const windowStart = deadlineTime + 30 * 60 * 1000;
  const windowEnd = deadlineTime + 60 * 60 * 1000;

  const now = date.getTime();
  return now >= windowStart && now <= windowEnd;
}

/**
 * Check if all conditions for live scores update are met
 */
export function shouldRunLiveScores(date = new Date()): boolean {
  const weekend = isWeekend(date);
  const season = isFPLSeason(date);
  const matchHours = isMatchHours(date);

  logInfo('Live scores conditions check', {
    isWeekend: weekend,
    isFPLSeason: season,
    isMatchHours: matchHours,
    month: date.getMonth() + 1,
    hour: date.getHours(),
  });

  return weekend && season && matchHours;
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
