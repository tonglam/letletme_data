import { describe, expect, test } from 'bun:test';

import {
  getPlayerValuesQueueJobId,
  waitForPlayerValuesSettlement,
  type ObservedPlayerValuesJobState,
} from '../../src/jobs/player-values-settlement';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

describe('player-values retry settlement', () => {
  test('uses the same season-qualified deterministic ID as the queue producer', () => {
    expect(getPlayerValuesQueueJobId(TEST_SEASON, '20260813')).toBe(
      `${TEST_SEASON.seasonCode}-player-values-20260813`,
    );
  });

  test('waits through active and delayed retries without reporting stale data', async () => {
    const states: ObservedPlayerValuesJobState[] = ['missing', 'active', 'delayed', 'missing'];
    let now = 0;
    const result = await waitForPlayerValuesSettlement(TEST_SEASON, '20260813', {
      timeoutMs: 300,
      pollMs: 100,
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      readState: async () => states.shift() ?? 'missing',
    });

    expect(result).toEqual({ settled: true, state: 'removed' });
    expect(now).toBe(300);
  });

  test('accepts a missing retained job immediately only with durable completion evidence', async () => {
    let now = 0;
    const result = await waitForPlayerValuesSettlement(TEST_SEASON, '20260813', {
      timeoutMs: 300,
      pollMs: 100,
      missingIsSettled: true,
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      readState: async () => 'missing',
    });

    expect(result).toEqual({ settled: true, state: 'removed' });
    expect(now).toBe(0);
  });

  test('keeps a never-observed final job inside the enqueue grace horizon', async () => {
    let now = 0;
    const result = await waitForPlayerValuesSettlement(TEST_SEASON, '20260813', {
      timeoutMs: 250,
      pollMs: 100,
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      readState: async () => 'missing',
    });

    expect(result).toEqual({ settled: false, state: 'not-observed' });
    expect(now).toBe(250);
  });

  test('returns the unsettled state only after the retry horizon expires', async () => {
    let now = 0;
    const result = await waitForPlayerValuesSettlement(TEST_SEASON, '20260813', {
      timeoutMs: 250,
      pollMs: 100,
      now: () => now,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      readState: async () => 'delayed',
    });

    expect(result).toEqual({ settled: false, state: 'delayed' });
    expect(now).toBe(250);
  });
});
