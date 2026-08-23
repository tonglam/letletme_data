import { describe, expect, test } from 'bun:test';

import {
  loadManagerLiveHotScope,
  MANAGER_LIVE_ATTEMPTS,
  MANAGER_LIVE_HOT_SCOPE_SECONDS,
  MANAGER_LIVE_RETRY_BASE_DELAY_MS,
  MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT,
  MANAGER_LIVE_WORKER_ENTRY_CHUNK_SIZE,
  MANAGER_LIVE_WORKER_REQUEST_DEADLINE_MS,
  MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT,
  managerLiveEntryChunks,
  managerLiveDispatchEntryChunks,
  managerLiveHotScopeKey,
  managerLiveRefreshJobId,
  parseManagerLiveHotScope,
  shouldStopManagerLiveRefresh,
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

  test('does not collapse different entry subsets from the same tournament', () => {
    const date = new Date('2026-08-23T08:34:01.000Z');
    const otherSubset = { ...scope, entryIds: [11, 22, 44] };

    expect(managerLiveRefreshJobId(otherSubset, date)).not.toBe(
      managerLiveRefreshJobId(scope, date),
    );
    expect(managerLiveHotScopeKey(otherSubset)).not.toBe(managerLiveHotScopeKey(scope));
  });

  test('splits a 500-entry request into deterministic bounded worker jobs', () => {
    const input = Array.from({ length: 500 }, (_, index) => 10_500 - index);
    const chunks = managerLiveEntryChunks([...input, input[0]!]);

    expect(chunks).toHaveLength(Math.ceil(500 / MANAGER_LIVE_WORKER_ENTRY_CHUNK_SIZE));
    expect(chunks.every((chunk) => chunk.length <= MANAGER_LIVE_WORKER_ENTRY_CHUNK_SIZE)).toBe(
      true,
    );
    expect(chunks.flat()).toEqual([...input].sort((left, right) => left - right));
  });

  test('keeps a classic standings feed in one cursor-bearing worker job', () => {
    const input = Array.from({ length: 500 }, (_, index) => index + 1);

    expect(managerLiveDispatchEntryChunks(input, false)).toEqual([input]);
    expect(managerLiveDispatchEntryChunks(input, true).length).toBeGreaterThan(1);
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

  test('stops follow-up eligibility when the hot scope expires or is malformed', async () => {
    const expiredRedis = {
      set: async () => 'OK',
      get: async () => null,
    };
    await expect(loadManagerLiveHotScope(expiredRedis as never, scope)).resolves.toBeNull();
    expect(parseManagerLiveHotScope('{"eventId":1}')).toBeNull();
  });

  test('configures one attempt plus 30, 60, and 120 second retries', () => {
    expect(MANAGER_LIVE_ATTEMPTS).toBe(4);
    expect(
      Array.from({ length: MANAGER_LIVE_ATTEMPTS - 1 }, (_, index) =>
        Math.round((MANAGER_LIVE_RETRY_BASE_DELAY_MS * 2 ** index) / 1000),
      ),
    ).toEqual([30, 60, 120]);
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
