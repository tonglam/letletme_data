/**
 * Job Condition Helpers
 *
 * Common utility functions for checking job execution conditions
 * Used by Elysia cron jobs and other scheduling logic
 */

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
