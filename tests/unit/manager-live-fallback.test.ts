import { describe, expect, test } from 'bun:test';

import {
  acquireDistributedLease,
  classicManagerBackgroundStandingsStartPage,
  classicManagerSummaryFallbackEntryIds,
  classicManagerSummaryFallbackNeedsRefresh,
  createDistributedLeaseFence,
  createKeyedSerialTaskGate,
  createKeyedSerialTaskScheduler,
  createKeyedTaskSerializer,
  createManagerSummaryFetchGate,
  isPositiveOverallRank,
  managerLiveBackgroundRefreshKey,
  managerSummaryFetchBatches,
  mergeUniqueTargetManagerRows,
  pendingManagerRefreshEntryIds,
  pendingOverallRankRefreshEntryIds,
  planClassicManagerFallback,
  planClassicOverallRankRefresh,
  planManagerLiveRefreshTargets,
  preserveClassicOverallRank,
  preserveLastKnownOverallRank,
  reconcileMonotonicCachePublicationRows,
  readThroughManagerSummaryResult,
  readLatestRowsWithFallback,
  requireManagerSummaryCoordinator,
  runManagerStandingsPageSequence,
  runYieldingKeyedTask,
  selectClassicSummaryOverallRank,
  selectForegroundClassicRankEntryIds,
  selectLatestCheckedRow,
  shouldAcceptClassicOverallRankPublication,
  shouldEnrichClassicOverallRank,
  shouldPreserveClassicStandingForRank,
  shouldRefreshClassicOverallRank,
  shouldRetryPendingClassicOverallRank,
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

  test('forces OR enrichment for refreshed standings rows that retain a positive old rank', () => {
    const refreshedEntryIds = new Set([1]);
    const rankOnlyEntryIds = new Set([2, 3, 4]);
    const isFresh = (row: { fresh: boolean }) => row.fresh;
    const needsOverallRank = (row: { overallRank: number | null }) =>
      !row.overallRank || row.overallRank <= 0;

    expect(
      shouldEnrichClassicOverallRank(
        1,
        { fresh: true, overallRank: 123 },
        refreshedEntryIds,
        rankOnlyEntryIds,
        isFresh,
        needsOverallRank,
      ),
    ).toBe(true);
    expect(
      shouldEnrichClassicOverallRank(
        2,
        { fresh: true, overallRank: null },
        refreshedEntryIds,
        rankOnlyEntryIds,
        isFresh,
        needsOverallRank,
      ),
    ).toBe(true);
    expect(
      shouldEnrichClassicOverallRank(
        3,
        { fresh: true, overallRank: 456 },
        refreshedEntryIds,
        rankOnlyEntryIds,
        isFresh,
        needsOverallRank,
      ),
    ).toBe(false);
    expect(
      shouldEnrichClassicOverallRank(
        4,
        { fresh: false, overallRank: null },
        refreshedEntryIds,
        rankOnlyEntryIds,
        isFresh,
        needsOverallRank,
      ),
    ).toBe(false);
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
  test('permanently fences publication after distributed lease ownership is lost', async () => {
    let ownsLease = true;
    const fence = createDistributedLeaseFence(async () => ownsLease);

    await expect(fence.assertOwned()).resolves.toBeUndefined();
    ownsLease = false;
    await expect(fence.assertOwned()).rejects.toThrow('distributed lease ownership lost');
    ownsLease = true;
    await expect(fence.assertOwned()).rejects.toThrow('distributed lease ownership lost');
  });

  test('fails the lease fence closed when renewal cannot be verified', async () => {
    const fence = createDistributedLeaseFence(async () => {
      throw new Error('redis unavailable');
    });

    await expect(fence.assertOwned()).rejects.toThrow('redis unavailable');
  });

  test('serializes standings and rank publications for the same Classic scope', async () => {
    const run = createKeyedSerialTaskGate();
    const order: string[] = [];
    let releaseStandings!: () => void;
    const standingsActive = new Promise<void>((resolve) => {
      releaseStandings = resolve;
    });

    const standings = run('classic:2627:1:8863', async () => {
      order.push('standings-start');
      await standingsActive;
      order.push('standings-end');
    });
    await Promise.resolve();
    const overallRank = run('classic:2627:1:8863', async () => {
      order.push('overall-rank');
    });
    const otherLeague = run('classic:2627:1:9999', async () => {
      order.push('other-league');
    });
    await otherLeague;

    expect(order).toEqual(['standings-start', 'other-league']);
    releaseStandings();
    await Promise.all([standings, overallRank]);
    expect(order).toEqual(['standings-start', 'other-league', 'standings-end', 'overall-rank']);
  });

  test('releases a keyed publication turn when its active task is aborted', async () => {
    const run = createKeyedSerialTaskGate();
    const controller = new AbortController();
    const order: string[] = [];
    let releaseUnderlying!: () => void;
    const underlying = new Promise<void>((resolve) => {
      releaseUnderlying = resolve;
    });

    const blocked = run(
      'classic:2627:1:8863',
      async () => {
        order.push('blocked-start');
        await underlying;
      },
      controller.signal,
    );
    await Promise.resolve();
    const next = run('classic:2627:1:8863', async () => {
      order.push('next');
    });

    controller.abort(new Error('deadline exceeded'));
    await expect(blocked).rejects.toThrow('deadline exceeded');
    await next;
    expect(order).toEqual(['blocked-start', 'next']);
    releaseUnderlying();
  });

  test('queues distinct background work while deduplicating the same work set', async () => {
    const schedule = createKeyedSerialTaskScheduler();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstActive = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = schedule('classic:8863', 'classic:8863:1,2', async () => {
      order.push('first-start');
      await firstActive;
      order.push('first-end');
    });
    await Promise.resolve();
    const duplicate = schedule('classic:8863', 'classic:8863:1,2', async () => {
      order.push('duplicate');
    });
    const distinct = schedule('classic:8863', 'classic:8863:3,4', async () => {
      order.push('distinct');
    });

    expect(duplicate).toBe(first);
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, duplicate, distinct]);
    expect(order).toEqual(['first-start', 'first-end', 'distinct']);
  });

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

  test('never returns a Classic row rejected by monotonic cache publication', () => {
    const publishedRows = [
      { entryId: 1, overallRank: 100, revision: 'accepted' },
      { entryId: 2, overallRank: 200, revision: 'rejected-stale' },
      { entryId: 3, overallRank: 300, revision: 'rejected-unreadable' },
    ];
    const authoritativeRejectedRows = new Map([
      [2, { entryId: 2, overallRank: 220, revision: 'newer-authoritative' }],
    ]);

    expect(
      reconcileMonotonicCachePublicationRows(publishedRows, [1], authoritativeRejectedRows),
    ).toEqual([
      publishedRows[0],
      { entryId: 2, overallRank: 220, revision: 'newer-authoritative' },
    ]);
    expect(reconcileMonotonicCachePublicationRows(publishedRows, null, new Map())).toEqual(
      publishedRows,
    );
  });

  test('publishes fallback fields while retaining a newer ordered rank', () => {
    const existing = { eventPoints: 32, totalPoints: 32, overallRank: 620_000 };
    const fallback = { eventPoints: 43, totalPoints: 43, overallRank: 640_000 };
    const published = {
      ...fallback,
      overallRank: selectClassicSummaryOverallRank(
        fallback.overallRank,
        existing.overallRank,
        false,
      ),
    };

    expect(published).toEqual({ eventPoints: 43, totalPoints: 43, overallRank: 620_000 });
    expect(selectClassicSummaryOverallRank(fallback.overallRank, existing.overallRank, true)).toBe(
      640_000,
    );
    expect(selectClassicSummaryOverallRank(null, existing.overallRank, false)).toBe(620_000);
    expect(selectClassicSummaryOverallRank(640_000, null, false)).toBeNull();
  });

  test('advances durable Classic OR evidence only for a newer valid publication', () => {
    const acceptedAt = '2026-08-23T08:00:01.000Z';

    expect(
      shouldAcceptClassicOverallRankPublication(620_000, '2026-08-23T08:00:02.000Z', acceptedAt),
    ).toBeTrue();
    expect(
      shouldAcceptClassicOverallRankPublication(620_000, '2026-08-23T08:00:00.000Z', acceptedAt),
    ).toBeFalse();
    expect(shouldAcceptClassicOverallRankPublication(620_000, acceptedAt, acceptedAt)).toBeFalse();
    expect(
      shouldAcceptClassicOverallRankPublication(null, '2026-08-23T08:00:02.000Z', acceptedAt),
    ).toBeFalse();
    expect(
      shouldAcceptClassicOverallRankPublication(0, '2026-08-23T08:00:02.000Z', acceptedAt),
    ).toBeFalse();
    expect(shouldAcceptClassicOverallRankPublication(620_000, 'invalid', acceptedAt)).toBeFalse();
    expect(
      shouldAcceptClassicOverallRankPublication(
        620_000,
        '2026-08-23T08:00:01.000101Z',
        '2026-08-23T08:00:01.000100Z',
      ),
    ).toBeTrue();
    expect(
      shouldAcceptClassicOverallRankPublication(
        620_000,
        '2026-08-23T08:00:01.000099Z',
        '2026-08-23T08:00:01.000100Z',
      ),
    ).toBeFalse();
  });

  test('counts a manager crossing standings pages only once and keeps the later row', () => {
    const targets = new Set([1, 2]);
    const firstPage = mergeUniqueTargetManagerRows(
      new Map<number, { entryId: number; leagueRank: number }>(),
      [
        { entryId: 1, leagueRank: 50 },
        { entryId: 3, leagueRank: 51 },
      ],
      targets,
    );
    const secondPage = mergeUniqueTargetManagerRows(
      firstPage,
      [
        { entryId: 1, leagueRank: 49 },
        { entryId: 2, leagueRank: 52 },
      ],
      targets,
    );

    expect(secondPage.size).toBe(2);
    expect(secondPage.get(1)?.leagueRank).toBe(49);
    expect(secondPage.get(2)?.leagueRank).toBe(52);
    expect(secondPage.has(3)).toBeFalse();
  });

  test('rebases delayed overall-rank work onto the latest standings row', () => {
    const deferredSnapshot = {
      checkedAt: '2026-08-23T08:00:00.000Z',
      eventPoints: 32,
      leagueRank: 40,
    };
    const nextStandingsRefresh = {
      checkedAt: '2026-08-23T08:00:30.000Z',
      eventPoints: 43,
      leagueRank: 25,
    };

    expect(selectLatestCheckedRow(deferredSnapshot, nextStandingsRefresh)).toBe(
      nextStandingsRefresh,
    );
    expect(selectLatestCheckedRow(nextStandingsRefresh, deferredSnapshot)).toBe(
      nextStandingsRefresh,
    );
  });

  test('orders standings rows by upstream snapshot before local completion time', () => {
    const newerSnapshot = {
      upstreamUpdatedAt: '2026-08-23T08:01:00.000Z',
      checkedAt: '2026-08-23T08:01:01.000Z',
      eventPoints: 43,
    };
    const delayedOlderSnapshot = {
      upstreamUpdatedAt: '2026-08-23T08:00:00.000Z',
      checkedAt: '2026-08-23T08:01:30.000Z',
      eventPoints: 32,
    };

    expect(selectLatestCheckedRow(newerSnapshot, delayedOlderSnapshot)).toBe(newerSnapshot);
    expect(selectLatestCheckedRow(delayedOlderSnapshot, newerSnapshot)).toBe(newerSnapshot);
  });

  test('preserves Classic fields for explicit overall-rank enrichment', () => {
    const classicRow = {
      source: 'FPL_CLASSIC_STANDINGS',
      checkedAt: '2026-08-23T08:00:00.000Z',
      eventPoints: 32,
      leagueRank: 40,
    };

    expect(shouldPreserveClassicStandingForRank(true, classicRow)).toBeTrue();
    expect(shouldPreserveClassicStandingForRank(false, classicRow)).toBeFalse();
    expect(shouldPreserveClassicStandingForRank(undefined, classicRow)).toBeFalse();
    expect(shouldPreserveClassicStandingForRank(true, { source: 'FPL_ENTRY_SUMMARY' })).toBeFalse();
  });

  test('does not preserve a stale standing that predates fallback Summary I/O', () => {
    const staleStanding = {
      source: 'FPL_CLASSIC_STANDINGS',
      checkedAt: '2026-08-23T08:00:00.000Z',
      eventPoints: 32,
      leagueRank: 40,
      overallRank: 640_000,
    };

    expect(
      shouldPreserveClassicStandingForRank(undefined, staleStanding, staleStanding),
    ).toBeFalse();
    expect(
      shouldPreserveClassicStandingForRank(
        undefined,
        { ...staleStanding, overallRank: 620_000 },
        staleStanding,
      ),
    ).toBeFalse();
  });

  test('preserves a standings publication that arrives during fallback Summary I/O', () => {
    const staleStanding = {
      source: 'FPL_CLASSIC_STANDINGS',
      checkedAt: '2026-08-23T08:00:00.000Z',
      upstreamUpdatedAt: '2026-08-23T07:59:55.000Z',
      eventPoints: 32,
      leagueRank: 40,
    };
    const freshStanding = {
      ...staleStanding,
      checkedAt: '2026-08-23T08:00:30.000Z',
      upstreamUpdatedAt: '2026-08-23T08:00:25.000Z',
      eventPoints: 43,
      leagueRank: 25,
    };

    expect(
      shouldPreserveClassicStandingForRank(undefined, freshStanding, staleStanding),
    ).toBeTrue();
    expect(shouldPreserveClassicStandingForRank(undefined, freshStanding, null)).toBeTrue();
  });

  test('recognizes a changed same-millisecond standings publication without using OR', () => {
    const baseline = {
      source: 'FPL_CLASSIC_STANDINGS',
      checkedAt: '2026-08-23T08:00:00.000Z',
      upstreamUpdatedAt: '2026-08-23T07:59:55.000Z',
      eventPoints: 32,
      leagueRank: 40,
      overallRank: 640_000,
    };

    expect(
      shouldPreserveClassicStandingForRank(
        undefined,
        { ...baseline, eventPoints: 43, leagueRank: 25 },
        baseline,
      ),
    ).toBeTrue();
    expect(
      shouldPreserveClassicStandingForRank(
        undefined,
        { ...baseline, overallRank: 620_000 },
        baseline,
      ),
    ).toBeFalse();
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
    expect(shouldRefreshClassicOverallRank({ overallRank: null }, true)).toBeTrue();
    expect(shouldRefreshClassicOverallRank({ overallRank: null }, false)).toBeTrue();
    expect(shouldRefreshClassicOverallRank(undefined, true)).toBeTrue();
    expect(shouldRefreshClassicOverallRank(undefined, false)).toBeTrue();
  });

  test('retains deferred and failed OR work until an OR-specific marker advances', () => {
    const baseline = new Map([
      [1, 'old-1'],
      [2, 'old-2'],
    ]);

    expect(shouldRetryPendingClassicOverallRank(1, false, baseline, baseline)).toBeTrue();
    expect(shouldRetryPendingClassicOverallRank(3, false, baseline, new Map())).toBeTrue();
    expect(shouldRetryPendingClassicOverallRank(1, false, null, baseline)).toBeTrue();
    expect(shouldRetryPendingClassicOverallRank(1, false, baseline, null)).toBeTrue();
  });

  test('drops OR work only after a later valid OR publication changes its marker', () => {
    const baseline = new Map([[1, 'old']]);
    const laterMarkers = new Map([
      [1, 'new'],
      [2, 'first'],
    ]);

    expect(shouldRetryPendingClassicOverallRank(1, false, baseline, laterMarkers)).toBeFalse();
    expect(shouldRetryPendingClassicOverallRank(2, false, baseline, laterMarkers)).toBeFalse();
    expect(shouldRetryPendingClassicOverallRank(1, true, baseline, laterMarkers)).toBeTrue();
  });

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

  test('resumes a cold-only standings crawl at the foreground cursor', () => {
    expect(classicManagerBackgroundStandingsStartPage([11, 12], new Set([11, 12]), 5)).toBe(5);
  });

  test('restarts standings at page one when stale rows share the background crawl', () => {
    expect(classicManagerBackgroundStandingsStartPage([11, 21], new Set([11]), 5)).toBe(1);
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

  test('shares one official summary observation across distributed waiters', async () => {
    const runDistributed = createKeyedTaskSerializer();
    let shared: { summary: { eventPoints: number }; observedAt: string } | null = null;
    let officialFetches = 0;
    const observedAt = '2026-08-23T13:00:00.000Z';

    const replicaRefresh = () =>
      runDistributed('entry-summary:7', () =>
        readThroughManagerSummaryResult(
          async () => shared,
          async () => {
            officialFetches += 1;
            return { summary: { eventPoints: 42 }, observedAt };
          },
          async (value) => {
            shared = value;
          },
        ),
      );

    const [first, second] = await Promise.all([replicaRefresh(), replicaRefresh()]);

    expect(first).toEqual({ summary: { eventPoints: 42 }, observedAt });
    expect(second).toEqual({ summary: { eventPoints: 42 }, observedAt });
    expect(officialFetches).toBe(1);
  });

  test('fails closed before an uncoordinated summary refresh can start', () => {
    expect(() => requireManagerSummaryCoordinator(null)).toThrow(
      'manager summary distributed coordination unavailable',
    );
    expect(requireManagerSummaryCoordinator({ available: true })).toEqual({ available: true });
  });

  test('fails closed when an official summary cannot be handed to other replicas', async () => {
    const pending = readThroughManagerSummaryResult(
      async () => null,
      async () => ({ eventPoints: 42 }),
      async () => {
        throw new Error('shared cache unavailable');
      },
    );

    await expect(pending).rejects.toThrow('shared cache unavailable');
  });

  test('fails closed when an entry-summary lease acquisition is ambiguous', async () => {
    let observedError: unknown;
    const pending = acquireDistributedLease(
      async () => {
        throw new Error('redis write timed out');
      },
      'fail-closed',
      (error) => {
        observedError = error;
      },
    );

    await expect(pending).rejects.toThrow('redis write timed out');
    expect(observedError).toBeInstanceOf(Error);
  });

  test('retains the durable classic fallback when lease coordination is unavailable', async () => {
    expect(
      await acquireDistributedLease(async () => {
        throw new Error('redis unavailable');
      }, 'fail-open'),
    ).toBe('uncoordinated');
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

  test('keeps retrying an active distributed lease until ownership is available', async () => {
    const run = createKeyedTaskSerializer();
    let attempts = 0;
    let taskRuns = 0;

    const result = await runYieldingKeyedTask(
      run,
      '2025:1:99',
      async () => {
        attempts += 1;
        if (attempts <= 75) return { complete: false };
        taskRuns += 1;
        return { complete: true, value: 'owned' };
      },
      'foreground',
      async () => undefined,
    );

    expect(result).toBe('owned');
    expect(attempts).toBe(76);
    expect(taskRuns).toBe(1);
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

  test('yields the league lane between background standings pages', async () => {
    const run = createKeyedTaskSerializer();
    const order: string[] = [];
    let releaseFirstPage!: () => void;
    const firstPageBlocked = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });

    const background = runManagerStandingsPageSequence(1, 3, (page) =>
      run(
        '2025:1:99',
        async () => {
          order.push(`background:${page}`);
          if (page === 1) await firstPageBlocked;
          return {
            complete: page === 3,
            nextPage: page + 1,
            errorCode: null,
            refreshedEntryIds: [page],
          };
        },
        'background',
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    const foreground = run('2025:1:99', async () => {
      order.push('foreground');
    });

    releaseFirstPage();
    const [result] = await Promise.all([background, foreground]);

    expect(result).toEqual({
      complete: true,
      nextPage: 4,
      errorCode: null,
      refreshedEntryIds: [1, 2, 3],
    });
    expect(order).toEqual(['background:1', 'foreground', 'background:2', 'background:3']);
  });

  test('stops the standings page sequence after a partial failure', async () => {
    const pages: number[] = [];

    const result = await runManagerStandingsPageSequence(1, 20, async (page) => {
      pages.push(page);
      return page === 2
        ? {
            complete: false,
            nextPage: 3,
            errorCode: 'UPSTREAM_UNAVAILABLE' as const,
            refreshedEntryIds: [22],
          }
        : {
            complete: false,
            nextPage: 2,
            errorCode: null,
            refreshedEntryIds: [11],
          };
    });

    expect(pages).toEqual([1, 2]);
    expect(result).toEqual({
      complete: false,
      nextPage: 3,
      errorCode: 'UPSTREAM_UNAVAILABLE',
      refreshedEntryIds: [11, 22],
    });
  });

  test('assigns ordering work only after prioritized Summary admission', async () => {
    const run = createManagerSummaryFetchGate(1);
    const order: string[] = [];
    let releaseActive: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });

    const runningBackground = run(async () => {
      order.push('background-active-reservation');
      await active;
    }, 'background');
    await Promise.resolve();
    const queuedBackground = run(async () => {
      order.push('background-queued-reservation');
    }, 'background');
    const foreground = run(async () => {
      order.push('foreground-reservation');
    }, 'foreground');

    releaseActive?.();
    await Promise.all([runningBackground, queuedBackground, foreground]);

    expect(order).toEqual([
      'background-active-reservation',
      'foreground-reservation',
      'background-queued-reservation',
    ]);
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
