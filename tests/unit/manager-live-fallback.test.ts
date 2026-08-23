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
  runYieldingKeyedTask,
  selectForegroundClassicRankEntryIds,
  shouldReplaceManagerLiveRow,
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

  test('enriches fresh rank-missing classic rows in the bounded foreground plan', () => {
    const rows = new Map([
      [1, { fresh: true, overallRank: null }],
      [2, { fresh: false, overallRank: null }],
      [3, { fresh: true, overallRank: 123 }],
      [4, { fresh: true, overallRank: 0 }],
      [5, { fresh: true, overallRank: null }],
    ]);

    expect(
      selectForegroundClassicRankEntryIds(
        [1, 2, 3, 4, 5],
        rows,
        (row) => row.fresh,
        (row) => !row.overallRank || row.overallRank <= 0,
        2,
      ),
    ).toEqual([1, 4]);
  });

  test('rejects a later local completion from an older upstream standings snapshot', () => {
    const current = {
      source: 'FPL_CLASSIC_STANDINGS' as const,
      checkedAt: '2026-08-23T10:00:00.000Z',
      upstreamUpdatedAt: '2026-08-23T09:59:00.000Z',
    };
    const slowerOlderReplica = {
      source: 'FPL_CLASSIC_STANDINGS' as const,
      checkedAt: '2026-08-23T10:01:00.000Z',
      upstreamUpdatedAt: '2026-08-23T09:58:00.000Z',
    };
    const newerUpstreamSnapshot = {
      source: 'FPL_CLASSIC_STANDINGS' as const,
      checkedAt: '2026-08-23T09:59:30.000Z',
      upstreamUpdatedAt: '2026-08-23T10:00:00.000Z',
    };

    expect(shouldReplaceManagerLiveRow(current, slowerOlderReplica)).toBe(false);
    expect(shouldReplaceManagerLiveRow(current, newerUpstreamSnapshot)).toBe(true);
  });

  test('keeps classic standings ahead of a later summary fallback', () => {
    const classic = {
      source: 'FPL_CLASSIC_STANDINGS' as const,
      checkedAt: '2026-08-23T10:00:00.000Z',
      upstreamUpdatedAt: '2026-08-23T09:59:00.000Z',
    };
    const summary = {
      source: 'FPL_ENTRY_SUMMARY' as const,
      checkedAt: '2026-08-23T10:01:00.000Z',
      upstreamUpdatedAt: null,
    };

    expect(shouldReplaceManagerLiveRow(classic, summary)).toBe(false);
    expect(shouldReplaceManagerLiveRow(summary, classic)).toBe(true);
  });

  test('falls back to serialized check time when upstream standings metadata is absent', () => {
    const current = {
      source: 'FPL_CLASSIC_STANDINGS' as const,
      checkedAt: '2026-08-23T10:00:00.000Z',
      upstreamUpdatedAt: '2026-08-23T09:59:00.000Z',
    };

    expect(
      shouldReplaceManagerLiveRow(current, {
        source: 'FPL_CLASSIC_STANDINGS',
        checkedAt: '2026-08-23T10:01:00.000Z',
        upstreamUpdatedAt: null,
      }),
    ).toBe(true);
    expect(
      shouldReplaceManagerLiveRow(current, {
        source: 'FPL_CLASSIC_STANDINGS',
        checkedAt: '2026-08-23T09:59:30.000Z',
        upstreamUpdatedAt: null,
      }),
    ).toBe(false);
  });

  test('replaces an invalid cached timestamp with a valid incoming row', () => {
    const invalidCurrent = {
      source: 'FPL_CLASSIC_STANDINGS' as const,
      checkedAt: 'not-a-timestamp',
      upstreamUpdatedAt: '2026-08-23T09:59:00.000Z',
    };
    const validIncoming = {
      source: 'FPL_ENTRY_SUMMARY' as const,
      checkedAt: '2026-08-23T10:01:00.000Z',
      upstreamUpdatedAt: null,
    };

    expect(shouldReplaceManagerLiveRow(invalidCurrent, validIncoming)).toBe(true);
    expect(
      shouldReplaceManagerLiveRow(validIncoming, {
        ...invalidCurrent,
        source: 'FPL_FINAL_RESULT',
      }),
    ).toBe(false);
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

  test('coalesces the same manager across overlapping refresh groups', async () => {
    const run = createManagerSummaryFetchGate(2);
    const calls = new Map<number, number>();
    let releaseFetches!: () => void;
    const fetchesBlocked = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });

    const refreshGroup = (entryIds: readonly number[]) =>
      Promise.all(
        entryIds.map((entryId) =>
          run(
            async () => {
              calls.set(entryId, (calls.get(entryId) ?? 0) + 1);
              await fetchesBlocked;
              return entryId;
            },
            'background',
            entryId,
          ),
        ),
      );

    const first = refreshGroup([1, 2]);
    const second = refreshGroup([2, 3]);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.get(2)).toBe(1);
    releaseFetches();
    expect(await first).toEqual([1, 2]);
    expect(await second).toEqual([2, 3]);
    expect(calls).toEqual(
      new Map([
        [1, 1],
        [2, 1],
        [3, 1],
      ]),
    );
  });

  test('starts a fresh keyed fetch after the shared request settles', async () => {
    const run = createManagerSummaryFetchGate(1);
    let calls = 0;

    expect(
      await run(
        async () => {
          calls += 1;
          return 'first';
        },
        'foreground',
        7,
      ),
    ).toBe('first');
    expect(
      await run(
        async () => {
          calls += 1;
          return 'second';
        },
        'foreground',
        7,
      ),
    ).toBe('second');
    expect(calls).toBe(2);
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

  test('releases the local lane between distributed lease attempts', async () => {
    const run = createKeyedTaskSerializer();
    const order: string[] = [];
    let releaseBackgroundRetry: (() => void) | undefined;
    const backgroundRetry = new Promise<void>((resolve) => {
      releaseBackgroundRetry = resolve;
    });
    let backgroundAttempts = 0;

    const background = runYieldingKeyedTask(
      run,
      '2025:1:99',
      async () => {
        backgroundAttempts += 1;
        if (backgroundAttempts === 1) {
          order.push('background:lease-contended');
          return { complete: false };
        }
        order.push('background:run');
        return { complete: true, value: 'background' };
      },
      'background',
      () => backgroundRetry,
    );
    await Promise.resolve();
    await Promise.resolve();

    const foreground = runYieldingKeyedTask(
      run,
      '2025:1:99',
      async () => {
        order.push('foreground:run');
        return { complete: true, value: 'foreground' };
      },
      'foreground',
      async () => undefined,
    );

    expect(await foreground).toBe('foreground');
    releaseBackgroundRetry?.();
    expect(await background).toBe('background');
    expect(order).toEqual(['background:lease-contended', 'foreground:run', 'background:run']);
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

  test('prefers a valid live cache row over a captured row with an invalid timestamp', async () => {
    const captured = new Map([[1, { checkedAt: 'invalid', value: 'captured' }]]);

    const rows = await readLatestRowsWithFallback(
      [1],
      captured,
      async () => new Map([[1, { checkedAt: '2026-08-23T10:01:00.000Z', value: 'live' }]]),
    );

    expect(rows.get(1)?.value).toBe('live');
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

  test('promotes a coalesced background manager when foreground work joins it', async () => {
    const run = createManagerSummaryFetchGate(1);
    const order: string[] = [];
    let releaseActive!: () => void;
    const activeBlocked = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });

    const active = run(
      async () => {
        order.push('active');
        await activeBlocked;
        return 'active';
      },
      'background',
      1,
    );
    await Promise.resolve();
    await Promise.resolve();
    const queuedManager = run(
      async () => {
        order.push('manager-2');
        return 'shared';
      },
      'background',
      2,
    );
    const queuedOther = run(
      async () => {
        order.push('manager-3');
        return 'other';
      },
      'background',
      3,
    );
    const joinedForeground = run(
      async () => {
        order.push('duplicate-manager-2');
        return 'duplicate';
      },
      'foreground',
      2,
    );

    releaseActive();
    expect(await Promise.all([active, queuedManager, queuedOther, joinedForeground])).toEqual([
      'active',
      'shared',
      'other',
      'shared',
    ]);
    expect(order).toEqual(['active', 'manager-2', 'manager-3']);
  });

  test('rejects an invalid shared concurrency limit', () => {
    expect(() => createManagerSummaryFetchGate(0)).toThrow(RangeError);
  });
});
