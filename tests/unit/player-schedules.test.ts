import { describe, expect, test } from 'bun:test';

import {
  PLAYER_MARKET_FRESHNESS_WATCHDOG_CRON_PATTERN,
  PLAYER_STATS_ACTIVE_CRON_PATTERN,
  PLAYER_PRICES_REPLAY_CRON_PATTERN,
  PLAYER_STATS_CRON_PATTERN,
  PLAYER_VALUES_CRON_PATTERN,
} from '../../src/domain/job-schedules';

describe('player synchronization schedules', () => {
  test('polls values from 09:25 through 09:35', () => {
    expect(PLAYER_VALUES_CRON_PATTERN).toBe('25-35 9 * * *');
  });

  test('checks market freshness at 09:36 UTC+8 without changing readiness', () => {
    expect(PLAYER_MARKET_FRESHNESS_WATCHDOG_CRON_PATTERN).toBe('36 9 * * *');
  });

  test('runs current-price replay and player stats daily at 09:40', () => {
    expect(PLAYER_PRICES_REPLAY_CRON_PATTERN).toBe('40 9 * * *');
    expect(PLAYER_STATS_CRON_PATTERN).toBe('40 9 * * *');
  });

  test('coordinates live player stats every minute and backs off in the job', () => {
    expect(PLAYER_STATS_ACTIVE_CRON_PATTERN).toBe('* * * * *');
  });
});
