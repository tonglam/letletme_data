import { describe, expect, test } from 'bun:test';

import {
  FplAdmissionCriticalWindowBusyError,
  FplAdmissionStoreUnavailableError,
  type FplAdmissionStoreUnavailableError as FplAdmissionStoreUnavailableErrorType,
} from '../../src/utils/fpl-admission';
import { openPriceWatchCriticalWindowWithRetry } from '../../src/workers/fpl-price-watch.worker';

describe('FPL price-watch Admission window', () => {
  test('retries a transient store failure within the active watch window', async () => {
    let nowMs = 0;
    let attempts = 0;
    const delays: number[] = [];
    const failures: FplAdmissionStoreUnavailableErrorType[] = [];

    await openPriceWatchCriticalWindowWithRetry({
      owner: 'price-watch-test',
      untilMs: 2_000,
      now: () => nowMs,
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        nowMs += delayMs;
      },
      openWindow: async () => {
        attempts += 1;
        if (attempts < 3) throw new FplAdmissionStoreUnavailableError();
      },
      onStoreFailure: (error) => failures.push(error),
    });

    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
    expect(failures).toHaveLength(2);
  });

  test('does not retry non-store failures', async () => {
    let attempts = 0;
    await expect(
      openPriceWatchCriticalWindowWithRetry({
        owner: 'price-watch-test',
        untilMs: Date.now() + 2_000,
        openWindow: async () => {
          attempts += 1;
          throw new Error('owner conflict');
        },
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('owner conflict');
    expect(attempts).toBe(1);
  });

  test('does not retry a critical-window ownership conflict as a store outage', async () => {
    let attempts = 0;
    await expect(
      openPriceWatchCriticalWindowWithRetry({
        owner: 'price-watch-test',
        untilMs: Date.now() + 2_000,
        openWindow: async () => {
          attempts += 1;
          throw new FplAdmissionCriticalWindowBusyError(Date.now() + 1_000);
        },
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'FPL_ADMISSION_CRITICAL_WINDOW_BUSY' });
    expect(attempts).toBe(1);
  });
});
