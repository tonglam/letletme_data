import { formatCronDateKey, getCronHour, getCronMinute } from '../utils/timezone';

/** The inclusive UTC+8 market capture window. */
export const PLAYER_VALUES_WINDOW_START_MINUTE = 6 * 60 + 55;
export const PLAYER_VALUES_WINDOW_LAST_MINUTE = 7 * 60 + 5;

/** One attempt per minute from 06:55 through 07:05, inclusive. */
export const PLAYER_VALUES_WINDOW_ATTEMPTS =
  PLAYER_VALUES_WINDOW_LAST_MINUTE - PLAYER_VALUES_WINDOW_START_MINUTE + 1;
export const PLAYER_VALUES_WINDOW_BACKOFF_MS = 60_000;

function cronMinuteOfDay(date: Date): number {
  return getCronHour(date) * 60 + getCronMinute(date);
}

/**
 * A no-change capture may be retried only before the final 07:05 attempt.
 * The final attempt is allowed to settle successfully with zero price changes;
 * the 07:06 watchdog then validates the complete snapshot.
 */
export function shouldRetryPlayerValuesNoChange(
  changeDate: string,
  now: Date = new Date(),
): boolean {
  if (formatCronDateKey(now) !== changeDate) return false;
  const minute = cronMinuteOfDay(now);
  return minute >= PLAYER_VALUES_WINDOW_START_MINUTE && minute < PLAYER_VALUES_WINDOW_LAST_MINUTE;
}

export class PlayerValuesWindowPendingError extends Error {
  readonly changeDate: string;

  constructor(changeDate: string) {
    super(`No player value changes observed yet for ${changeDate}; retrying until 07:05 UTC+8`);
    this.name = 'PlayerValuesWindowPendingError';
    this.changeDate = changeDate;
  }
}
