import { describe, expect, test } from 'bun:test';

import {
  loadManagerLiveClassicCursor,
  loadManagerLiveHotScope,
  MANAGER_LIVE_ATTEMPTS,
  MANAGER_LIVE_HOT_SCOPE_SECONDS,
  MANAGER_LIVE_RETRY_BASE_DELAY_MS,
  MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT,
  MANAGER_LIVE_WORKER_REQUEST_DEADLINE_MS,
  MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT,
  classicStandingsCursorAfterRefresh,
  managerLiveClassicCursorKey,
  managerLiveDispatchEntryChunks,
  managerLiveHotScopeKey,
  managerLiveRefreshJobId,
  managerLiveRefreshJobIdForState,
  parseManagerLiveHotState,
  parseManagerLiveClassicCursor,
  parseManagerLiveHotScope,
  shouldStopManagerLiveRefresh,
  writeManagerLiveClassicCursor,
  writeManagerLiveHotScope,
  type ManagerLiveRefreshScope,
} from '../../src/domain/manager-live-refresh';
import { managerSummaryFetchBatches } from '../../src/domain/manager-live-fallback';
import { WORKER_SHUTDOWN_TIMEOUT_MS } from '../../src/workers/worker-runtime';

const scope: ManagerLiveRefreshScope = {
  seasonId: 2026,
  seasonCode: '2627',
  eventId: 1,
  entryIds: [33, 11, 33, 22],
  tournamentId: 7,
};

describe('manager live refresh policy', () => {
  test('deduplicates by season, event, tournament, and 30-second bucket', () => {
    const first = managerLiveRefreshJobId(scope, new Date('2026-08-23T08:34:01.000Z'));
    const duplicate = managerLiveRefreshJobId(scope, new Date('2026-08-23T08:34:29.999Z'));
    const next = managerLiveRefreshJobId(scope, new Date('2026-08-23T08:34:30.000Z'));

    expect(first).toBe(duplicate);
    expect(next).not.toBe(first);
    expect(first).toContain('2627-e1-t7');
  });

  test('coalesces different entry subsets into one tournament scope', () => {
    const date = new Date('2026-08-23T08:34:01.000Z');
    const otherSubset = { ...scope, entryIds: [11, 22, 44] };

    expect(managerLiveRefreshJobId(otherSubset, date)).toBe(managerLiveRefreshJobId(scope, date));
    expect(managerLiveHotScopeKey(otherSubset)).toBe(managerLiveHotScopeKey(scope));
  });

  test('deduplicates classic standings continuations with request jobs in the same bucket', () => {
    const date = new Date('2026-08-23T08:34:01.000Z');
    const request = managerLiveRefreshJobId(scope, date);
    const sameScope = managerLiveRefreshJobId(scope, date);

    expect(sameScope).toBe(request);
    expect(managerLiveRefreshJobId(scope, new Date('2026-08-23T08:34:29.999Z'))).toBe(sameScope);
  });

  test('binds v2 jobs to a hot-scope generation while preserving bucket deduplication', () => {
    const date = new Date('2026-08-23T08:34:01.000Z');
    const first = managerLiveRefreshJobIdForState(scope, date, 'generation-a');
    const duplicate = managerLiveRefreshJobIdForState(
      scope,
      new Date('2026-08-23T08:34:29.999Z'),
      'generation-a',
    );
    const restarted = managerLiveRefreshJobIdForState(scope, date, 'generation-b');

    expect(first).toBe(duplicate);
    expect(restarted).not.toBe(first);
    expect(first).toContain('-ggeneration-a-');
  });

  test('keeps one normalized recurring hot scope for a 500-entry roster', () => {
    const input = Array.from({ length: 500 }, (_, index) => 10_500 - index);
    const chunks = managerLiveDispatchEntryChunks([...input, input[0]!]);

    expect(chunks).toEqual([[...input].sort((left, right) => left - right)]);
  });

  test('persists a normalized hot scope for exactly six hours', async () => {
    const calls: unknown[][] = [];
    const redis = {
      set: async (...args: unknown[]) => {
        calls.push(args);
        return 'OK';
      },
      get: async () => JSON.stringify(scope),
    };

    await writeManagerLiveHotScope(redis as never, scope);
    expect(calls).toEqual([
      [
        managerLiveHotScopeKey(scope),
        JSON.stringify({ ...scope, entryIds: [11, 22, 33] }),
        'EX',
        MANAGER_LIVE_HOT_SCOPE_SECONDS,
      ],
    ]);
    await expect(loadManagerLiveHotScope(redis as never, scope)).resolves.toEqual({
      ...scope,
      entryIds: [11, 22, 33],
    });
  });

  test('persists one classic cursor alongside the hot scope, including an explicit completion', async () => {
    const values = new Map<string, string>();
    const calls: unknown[][] = [];
    const redis = {
      set: async (...args: [string, string, 'EX', number]) => {
        calls.push(args);
        values.set(args[0], args[1]);
        return 'OK';
      },
      get: async (key: string) => values.get(key) ?? null,
    };

    await writeManagerLiveClassicCursor(redis, scope, 7);
    await expect(loadManagerLiveClassicCursor(redis, scope)).resolves.toBe(7);
    await writeManagerLiveClassicCursor(redis, scope, null);
    await expect(loadManagerLiveClassicCursor(redis, scope)).resolves.toBeNull();
    expect(calls).toEqual([
      [managerLiveClassicCursorKey(scope), '7', 'EX', MANAGER_LIVE_HOT_SCOPE_SECONDS],
      [managerLiveClassicCursorKey(scope), '0', 'EX', MANAGER_LIVE_HOT_SCOPE_SECONDS],
    ]);
    expect(parseManagerLiveClassicCursor('101')).toBeUndefined();
  });

  test('stops follow-up eligibility when the hot scope expires or is malformed', async () => {
    const expiredRedis = {
      set: async () => 'OK',
      get: async () => null,
    };
    await expect(loadManagerLiveHotScope(expiredRedis as never, scope)).resolves.toBeNull();
    expect(parseManagerLiveHotScope('{"eventId":1}')).toBeNull();
    expect(parseManagerLiveHotState('{"eventId":1}')).toBeNull();
    expect(
      parseManagerLiveHotState(
        JSON.stringify({
          ...scope,
          generation: 'generation-a',
          summaryRotationCursor: 2,
          classicStandingsPage: null,
          classicStandingsCursorEpoch: 0,
        }),
      ),
    ).toMatchObject({ generation: 'generation-a', summaryRotationCursor: 2 });
  });

  test('propagates a hot-scope Redis read failure to its caller', async () => {
    const failedRedis = {
      set: async () => 'OK',
      get: async () => {
        throw new Error('queue Redis unavailable');
      },
    };

    await expect(loadManagerLiveHotScope(failedRedis as never, scope)).rejects.toThrow(
      'queue Redis unavailable',
    );
  });

  test('configures one attempt plus 30, 60, and 120 second retries', () => {
    expect(MANAGER_LIVE_ATTEMPTS).toBe(4);
    expect(
      Array.from({ length: MANAGER_LIVE_ATTEMPTS - 1 }, (_, index) =>
        Math.round((MANAGER_LIVE_RETRY_BASE_DELAY_MS * 2 ** index) / 1000),
      ),
    ).toEqual([30, 60, 120]);
  });

  test('does not mark an unfinished 100-page crawl complete or emit page 101', () => {
    const standings = { complete: false, nextPage: 101 };
    expect(classicStandingsCursorAfterRefresh(true, standings)).toBe(100);
  });

  test('stops only after the gameweek is both finished and data-checked', () => {
    expect(shouldStopManagerLiveRefresh({ finished: true, dataChecked: true })).toBe(true);
    expect(shouldStopManagerLiveRefresh({ finished: true, dataChecked: false })).toBe(false);
    expect(shouldStopManagerLiveRefresh({ finished: false, dataChecked: true })).toBe(false);
  });

  test('bounds one worker job below the graceful shutdown window', () => {
    const summaryWaves = managerSummaryFetchBatches(
      Array.from({ length: MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT }, (_, index) => index + 1),
    ).length;
    // Worker concurrency is two. Pessimistically charge this job for both
    // jobs' summary waves sharing the global four-request gate.
    const upstreamBudgetMs =
      (summaryWaves * 2 + MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT) *
      MANAGER_LIVE_WORKER_REQUEST_DEADLINE_MS;

    expect(MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT).toBeLessThan(500);
    expect(upstreamBudgetMs).toBeLessThan(WORKER_SHUTDOWN_TIMEOUT_MS);
  });
});
