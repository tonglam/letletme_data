import { describe, expect, test } from 'bun:test';

import {
  createManagerSummaryFetchGate,
  managerSummaryFetchBatches,
  planClassicManagerFallback,
} from '../../src/domain/manager-live-fallback';

describe('classic manager live fallback', () => {
  test('uses official entry summaries after standings pagination is exhausted', () => {
    expect(planClassicManagerFallback([97_001], true)).toEqual({
      foregroundSummaryEntryIds: [97_001],
      backgroundEntryIds: [97_001],
      continueStandings: false,
    });
  });

  test('continues bounded standings pagination before falling back to summaries', () => {
    expect(planClassicManagerFallback([1, 2, 3, 4, 5], false)).toEqual({
      foregroundSummaryEntryIds: [],
      backgroundEntryIds: [1, 2, 3, 4, 5],
      continueStandings: true,
    });
  });

  test('bounds foreground summary requests while retaining all background work', () => {
    expect(planClassicManagerFallback([1, 2, 3, 4, 5], true)).toEqual({
      foregroundSummaryEntryIds: [1, 2, 3, 4],
      backgroundEntryIds: [1, 2, 3, 4, 5],
      continueStandings: false,
    });
  });

  test('caps concurrent entry-summary work while retaining every target', () => {
    const entryIds = Array.from({ length: 11 }, (_, index) => index + 1);

    const batches = managerSummaryFetchBatches(entryIds);

    expect(batches.map((batch) => batch.length)).toEqual([4, 4, 3]);
    expect(batches.flat()).toEqual(entryIds);
  });

  test('shares one concurrency cap across simultaneous refresh groups', async () => {
    const run = createManagerSummaryFetchGate(2);
    let active = 0;
    let maximumActive = 0;
    let releaseFirstWave: (() => void) | undefined;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });

    const refreshGroup = (entryIds: readonly number[]) =>
      Promise.all(
        entryIds.map((entryId) =>
          run(async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await firstWave;
            active -= 1;
            return entryId;
          }),
        ),
      );

    const pending = Promise.all([refreshGroup([1, 2, 3]), refreshGroup([4, 5, 6])]);
    await Promise.resolve();
    await Promise.resolve();

    expect(active).toBe(2);
    releaseFirstWave?.();
    expect((await pending).flat()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(maximumActive).toBe(2);
  });

  test('admits foreground work before queued background batches', async () => {
    const run = createManagerSummaryFetchGate(1);
    const order: string[] = [];
    let releaseActive: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });

    const runningBackground = run(async () => {
      order.push('background-active');
      await active;
    }, 'background');
    await Promise.resolve();
    const queuedBackground = run(async () => {
      order.push('background-queued');
    }, 'background');
    const foreground = run(async () => {
      order.push('foreground');
    }, 'foreground');

    releaseActive?.();
    await Promise.all([runningBackground, queuedBackground, foreground]);

    expect(order).toEqual(['background-active', 'foreground', 'background-queued']);
  });

  test('rejects an invalid shared concurrency limit', () => {
    expect(() => createManagerSummaryFetchGate(0)).toThrow(RangeError);
  });
});
