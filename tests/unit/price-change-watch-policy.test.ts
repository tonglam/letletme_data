import { describe, expect, test } from 'bun:test';

import {
  PRICE_CHANGE_WATCH_LEAD_MS,
  PRICE_CHANGE_WATCH_NEAR_POLL_MS,
  PRICE_CHANGE_WATCH_POST_DEADLINE_POLL_MS,
  PRICE_CHANGE_WATCH_PREWARM_POLL_MS,
  PRICE_CHANGE_WATCH_SLOW_POLL_MS,
  PRICE_CHANGE_WATCH_WARM_POLL_MS,
  resolvePriceChangeWatchPollInterval,
  resolvePriceChangeWatchSleepDelay,
} from '../../src/domain/price-change-watch-policy';

describe('price-change deadline watch policy', () => {
  const deadlineMs = Date.parse('2026-08-27T07:00:00.000Z');

  test('starts five minutes early and increases cadence near the deadline', () => {
    expect(PRICE_CHANGE_WATCH_LEAD_MS).toBe(5 * 60_000);
    expect(
      resolvePriceChangeWatchPollInterval(deadlineMs - PRICE_CHANGE_WATCH_LEAD_MS, deadlineMs),
    ).toBe(PRICE_CHANGE_WATCH_PREWARM_POLL_MS);
    expect(resolvePriceChangeWatchPollInterval(deadlineMs - 2 * 60_000, deadlineMs)).toBe(
      PRICE_CHANGE_WATCH_WARM_POLL_MS,
    );
    expect(resolvePriceChangeWatchPollInterval(deadlineMs - 11_000, deadlineMs)).toBe(1_000);
    expect(resolvePriceChangeWatchPollInterval(deadlineMs - 10_000, deadlineMs)).toBe(
      PRICE_CHANGE_WATCH_NEAR_POLL_MS,
    );
  });

  test('probes four times per second after deadline before returning to slow repair', () => {
    expect(resolvePriceChangeWatchPollInterval(deadlineMs, deadlineMs)).toBe(
      PRICE_CHANGE_WATCH_POST_DEADLINE_POLL_MS,
    );
    expect(resolvePriceChangeWatchPollInterval(deadlineMs + 90_000, deadlineMs)).toBe(
      PRICE_CHANGE_WATCH_POST_DEADLINE_POLL_MS,
    );
    expect(resolvePriceChangeWatchPollInterval(deadlineMs + 90_001, deadlineMs)).toBe(
      PRICE_CHANGE_WATCH_SLOW_POLL_MS,
    );
  });

  test('subtracts request time so the post-deadline cadence is start-to-start', () => {
    expect(
      resolvePriceChangeWatchSleepDelay({
        probeStartedAtMs: deadlineMs,
        probeCompletedAtMs: deadlineMs + 100,
        deadlineMs,
        stopAtMs: deadlineMs + 5 * 60_000,
        retryDelayMs: 0,
      }),
    ).toBe(150);
    expect(
      resolvePriceChangeWatchSleepDelay({
        probeStartedAtMs: deadlineMs,
        probeCompletedAtMs: deadlineMs + 300,
        deadlineMs,
        stopAtMs: deadlineMs + 5 * 60_000,
        retryDelayMs: 0,
      }),
    ).toBe(0);
  });
});
