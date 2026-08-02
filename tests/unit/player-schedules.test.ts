import { describe, expect, test } from 'bun:test';

import {
  PLAYER_PRICES_REPLAY_CRON_PATTERN,
  PLAYER_STATS_CRON_PATTERN,
  PLAYER_VALUES_CRON_PATTERN,
} from '../../src/domain/job-schedules';

describe('player synchronization schedules', () => {
  test('polls values from 09:25 through 09:35', () => {
    expect(PLAYER_VALUES_CRON_PATTERN).toBe('25-35 9 * * *');
  });

  test('runs current-price replay and player stats daily at 09:40', () => {
    expect(PLAYER_PRICES_REPLAY_CRON_PATTERN).toBe('40 9 * * *');
    expect(PLAYER_STATS_CRON_PATTERN).toBe('40 9 * * *');
  });
});
