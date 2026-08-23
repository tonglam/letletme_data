import { describe, expect, test } from 'bun:test';

import {
  classicManagerSummaryFallbackEntryIds,
  classicManagerSummaryFallbackNeedsRefresh,
  createKeyedTaskSerializer,
  createManagerSummaryFetchGate,
  managerLiveBackgroundRefreshKey,
  managerSummaryFetchBatches,
  pendingManagerRefreshEntryIds,
  planClassicManagerFallback,
  planManagerLiveRefreshTargets,
  preserveClassicOverallRank,
  readLatestRowsWithFallback,
} from '../../src/domain/manager-live-fallback';

describe('manager live refresh targets', () => {
  test('serves stale last-good rows without foreground upstream work', () => {
    expect(planManagerLiveRefreshTargets([1, 2], new Set([1, 2]), new Set())).toEqual({
      foregroundEntryIds: [],
      backgroundEntryIds: [1, 2],
    });
  });

  test('keeps cold misses in both the bounded foreground and background plans', () => {
    expect(planManagerLiveRefreshTargets([1, 2], new Set([1]), new Set([1]))).toEqual({
      foregroundEntryIds: [2],
      backgroundEntryIds: [2],
    });
  });

  test('does no refresh work for fresh cached rows', () => {
    expect(planManagerLiveRefreshTargets([1, 2], new Set([1, 2]), new Set([1, 2]))).toEqual({
      foregroundEntryIds: [],
      backgroundEntryIds: [],
    });
  });

  test('prunes targets that became fresh while waiting for a serialized lane', () => {
    const rows = new Map([
      [1, { fresh: true }],
      [2, { fresh: false }],
    ]);

    expect(pendingManagerRefreshEntryIds([1, 2, 3], rows, (row) => row.fresh)).toEqual([2, 3]);
  });

  test('preserves an enriched OR when a standings refresh omits it', () => {
    expect(preserveClassicOverallRank(null, 12_345)).toBe(12_345);
    expect(preserveClassicOverallRank(null, 0)).toBeNull();
    expect(preserveClassicOverallRank(54_321, undefined)).toBe(54_321);
    expect(preserveClassicOverallRank(54_321, 12_345)).toBe(54_321);
  });
});

describe('classic manager live fallback', () => {
  test('uses official entry summaries after standings pagination is exhausted', () => {
    expect(planClassicManagerFallback([97_001], [], true)).toEqual({
      foregroundSummaryEntryIds: [97_001],
      backgroundStandingsEntryIds: [],
      backgroundSummaryEntryIds: [97_001],
    });
  });

  test('continues bounded standings pagination before falling back to summaries', () => {
    expect(planClassicManagerFallback([1, 2, 3, 4, 5], [], false)).toEqual({
      foregroundSummaryEntryIds: [],
      backgroundStandingsEntryIds: [1, 2, 3, 4, 5],
      backgroundSummaryEntryIds: [],
    });
  });

  test('bounds foreground summary requests while retaining all background work', () => {
    expect(planClassicManagerFallback([1, 2, 3, 4, 5], [], true)).toEqual({
      foregroundSummaryEntryIds: [1, 2, 3, 4],
      backgroundStandingsEntryIds: [],
      backgroundSummaryEntryIds: [1, 2, 3, 4, 5],
    });
  });

  test('keeps stale classic rows on the standings path after a cold crawl completes', () => {
    expect(planClassicManagerFallback([11], [21, 22], true)).toEqual({
      foregroundSummaryEntryIds: [11],
      backgroundStandingsEntryIds: [21, 22],
      backgroundSummaryEntryIds: [11],
    });
  });

  test('uses entry-set-specific background refresh keys', () => {
    expect(managerLiveBackgroundRefreshKey('summary:2025:1', [3, 1, 3])).toBe('summary:2025:1:1,3');
    expect(managerLiveBackgroundRefreshKey('summary:2025:1', [2])).not.toBe(
      managerLiveBackgroundRefreshKey('summary:2025:1', [1]),
    );
  });

  test('refreshes stale summary fallbacks without replacing stale standings rows', () => {
    expect(
      classicManagerSummaryFallbackEntryIds([11], [21, 22, 23], new Set([21]), new Set([22]), true),
    ).toEqual([11, 21, 22]);
    expect(
      classicManagerSummaryFallbackEntryIds(
        [11],
        [21, 22, 23],
        new Set([21]),
        new Set([22]),
        false,
      ),
    ).toEqual([11]);
  });

  test('publishes summary fallback only for missing or stale summary rows', () => {
    expect(classicManagerSummaryFallbackNeedsRefresh(undefined, false)).toBe(true);
    expect(classicManagerSummaryFallbackNeedsRefresh({ source: 'FPL_ENTRY_SUMMARY' }, false)).toBe(
      true,
    );
    expect(classicManagerSummaryFallbackNeedsRefresh({ source: 'FPL_ENTRY_SUMMARY' }, true)).toBe(
      false,
    );
    expect(
      classicManagerSummaryFallbackNeedsRefresh({ source: 'FPL_CLASSIC_STANDINGS' }, false),
    ).toBe(false);
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

  test('serializes league-scoped crawls while retaining disjoint work', async () => {
    const run = createKeyedTaskSerializer();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = run(
      '2025:1:99',
      async () => {
        order.push('first:start');
        await firstBlocked;
        order.push('first:end');
        return [1];
      },
      'background',
    );
    const second = run(
      '2025:1:99',
      async () => {
        order.push('second:start');
        return [2];
      },
      'background',
    );
    const otherLeague = run('2025:1:100', async () => {
      order.push('other:start');
      return [3];
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first:start', 'other:start']);
    releaseFirst?.();
    expect(await Promise.all([first, second, otherLeague])).toEqual([[1], [2], [3]]);
    expect(order).toEqual(['first:start', 'other:start', 'first:end', 'second:start']);
  });

  test('admits a foreground league crawl before queued background work', async () => {
    const run = createKeyedTaskSerializer();
    const order: string[] = [];
    let releaseActive: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });

    const runningBackground = run(
      '2025:1:99',
      async () => {
        order.push('background-active');
        await active;
      },
      'background',
    );
    await Promise.resolve();
    const queuedBackground = run(
      '2025:1:99',
      async () => {
        order.push('background-queued');
      },
      'background',
    );
    const foreground = run('2025:1:99', async () => {
      order.push('foreground');
    });

    releaseActive?.();
    await Promise.all([runningBackground, queuedBackground, foreground]);
    expect(order).toEqual(['background-active', 'foreground', 'background-queued']);
  });

  test('keeps captured checkpoint rows when a background Redis read fails', async () => {
    const captured = new Map([[1, { checkedAt: '2026-08-23T10:00:00.000Z', value: 'checkpoint' }]]);
    let observedError: unknown;

    const rows = await readLatestRowsWithFallback(
      [1],
      captured,
      async () => {
        throw new Error('redis unavailable');
      },
      (error) => {
        observedError = error;
      },
    );

    expect(rows.get(1)?.value).toBe('checkpoint');
    expect(observedError).toBeInstanceOf(Error);
  });

  test('prefers a newer Redis row over a captured checkpoint row', async () => {
    const captured = new Map([[1, { checkedAt: '2026-08-23T10:00:00.000Z', value: 'checkpoint' }]]);

    const rows = await readLatestRowsWithFallback(
      [1],
      captured,
      async () => new Map([[1, { checkedAt: '2026-08-23T10:01:00.000Z', value: 'redis' }]]),
    );

    expect(rows.get(1)?.value).toBe('redis');
  });

  test('prefers the serialized cache publication when timestamps tie', async () => {
    const captured = new Map([[1, { checkedAt: '2026-08-23T10:00:00.000Z', value: 'captured' }]]);

    const rows = await readLatestRowsWithFallback(
      [1],
      captured,
      async () => new Map([[1, { checkedAt: '2026-08-23T10:00:00.000Z', value: 'serialized' }]]),
    );

    expect(rows.get(1)?.value).toBe('serialized');
  });

  test('yields the league lane between background summary batches', async () => {
    const run = createKeyedTaskSerializer();
    const order: string[] = [];
    let releaseFirstBatch: (() => void) | undefined;
    const firstBatchBlocked = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });

    const background = (async () => {
      for (const batch of managerSummaryFetchBatches([1, 2, 3, 4, 5, 6, 7, 8])) {
        await run(
          '2025:1:99',
          async () => {
            order.push(`background:${batch[0]}`);
            if (batch[0] === 1) await firstBatchBlocked;
          },
          'background',
        );
      }
    })();
    await Promise.resolve();
    await Promise.resolve();
    const foreground = run('2025:1:99', async () => {
      order.push('foreground');
    });

    releaseFirstBatch?.();
    await Promise.all([background, foreground]);

    expect(order).toEqual(['background:1', 'foreground', 'background:5']);
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
