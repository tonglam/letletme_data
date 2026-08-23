import { describe, expect, test } from 'bun:test';

import {
  createManagerSummaryFetchGate,
  isPositiveOverallRank,
  managerSummaryFetchBatches,
  pendingOverallRankRefreshEntryIds,
  planClassicManagerFallback,
  planClassicOverallRankRefresh,
  preserveLastKnownOverallRank,
  shouldRefreshClassicOverallRank,
} from '../../src/domain/manager-live-fallback';

describe('classic manager live fallback', () => {
  test('keeps the last positive overall rank until a newer positive rank arrives', () => {
    expect(preserveLastKnownOverallRank(null, 640_000)).toBe(640_000);
    expect(preserveLastKnownOverallRank(0, 640_000)).toBe(640_000);
    expect(preserveLastKnownOverallRank(-1, 640_000)).toBe(640_000);
    expect(preserveLastKnownOverallRank(undefined, 640_000)).toBe(640_000);
    expect(preserveLastKnownOverallRank(620_000, 640_000)).toBe(620_000);
    expect(preserveLastKnownOverallRank(null, null)).toBeNull();
    expect(isPositiveOverallRank(620_000)).toBeTrue();
    expect(isPositiveOverallRank(0)).toBeFalse();
  });

  test('keeps the foreground rank budget while retaining deferred and failed work', () => {
    const entryIds = Array.from({ length: 98 }, (_, index) => index + 1);
    const plan = planClassicOverallRankRefresh(entryIds);

    expect(plan.entryIds).toHaveLength(98);
    expect(plan.foregroundEntryIds).toEqual(entryIds.slice(0, 20));
    expect(pendingOverallRankRefreshEntryIds(plan.entryIds, plan.foregroundEntryIds)).toEqual(
      entryIds.slice(20),
    );
    expect(
      pendingOverallRankRefreshEntryIds(plan.entryIds, plan.foregroundEntryIds.slice(1)),
    ).toEqual([1, ...entryIds.slice(20)]);
  });

  test('deduplicates overall-rank refresh targets without changing their order', () => {
    expect(planClassicOverallRankRefresh([3, 1, 3, 2, 1]).entryIds).toEqual([3, 1, 2]);
  });

  test('does not spend the foreground OR budget on unresolved standings rows', () => {
    const entryIds = Array.from({ length: 98 }, (_, index) => index + 1);
    const standingsResolvedEntryIds = entryIds.slice(20);
    const plan = planClassicOverallRankRefresh(entryIds, standingsResolvedEntryIds);

    expect(plan.entryIds).toEqual(entryIds);
    expect(plan.foregroundEntryIds).toEqual(entryIds.slice(20, 40));
    expect(plan.foregroundEntryIds.some((entryId) => entryId <= 20)).toBeFalse();
  });

  test('refreshes expired rows and fresh Classic rows that still lack a rank', () => {
    const positiveClassicRow = {
      source: 'FPL_CLASSIC_STANDINGS',
      overallRank: 640_000,
    };

    expect(shouldRefreshClassicOverallRank(positiveClassicRow, true)).toBeTrue();
    expect(
      shouldRefreshClassicOverallRank({ ...positiveClassicRow, overallRank: null }, false),
    ).toBeTrue();
    expect(shouldRefreshClassicOverallRank(positiveClassicRow, false)).toBeFalse();
    expect(
      shouldRefreshClassicOverallRank({ source: 'FPL_ENTRY_SUMMARY', overallRank: null }, true),
    ).toBeTrue();
    expect(shouldRefreshClassicOverallRank(undefined, true)).toBeTrue();
  });

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
