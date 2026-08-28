import { describe, expect, test } from 'bun:test';

import {
  PLAYER_MARKET_FRESHNESS_WATCHDOG_CRON_PATTERN,
  PLAYER_STATS_ACTIVE_CRON_PATTERN,
  PLAYER_PRICES_REPLAY_CRON_PATTERN,
  PLAYER_STATS_CRON_PATTERN,
  PLAYER_VALUES_CRON_PATTERN,
  PLAYER_VALUES_CRON_ROLLOVER_PATTERN,
} from '../../src/domain/job-schedules';

describe('player synchronization schedules', () => {
  test('polls values from 06:55 through 07:05 UTC+8', () => {
    expect(PLAYER_VALUES_CRON_PATTERN).toBe('55-59 6 * * *');
    expect(PLAYER_VALUES_CRON_ROLLOVER_PATTERN).toBe('0-5 7 * * *');
  });

  test('checks market freshness at 07:06 UTC+8 without changing readiness', () => {
    expect(PLAYER_MARKET_FRESHNESS_WATCHDOG_CRON_PATTERN).toBe('6 7 * * *');
  });

  test('runs current-price replay at 07:10 and player stats daily at 09:40', () => {
    expect(PLAYER_PRICES_REPLAY_CRON_PATTERN).toBe('10 7 * * *');
    expect(PLAYER_STATS_CRON_PATTERN).toBe('40 9 * * *');
  });

  test('coordinates live player stats every minute and backs off in the job', () => {
    expect(PLAYER_STATS_ACTIVE_CRON_PATTERN).toBe('* * * * *');
  });
});
