import { describe, expect, test } from 'bun:test';

import {
  loadManagerLiveHotScope,
  MANAGER_LIVE_ATTEMPTS,
  MANAGER_LIVE_HOT_SCOPE_SECONDS,
  MANAGER_LIVE_RETRY_BASE_DELAY_MS,
  managerLiveHotScopeKey,
  managerLiveRefreshJobId,
  parseManagerLiveHotScope,
  shouldStopManagerLiveRefresh,
  writeManagerLiveHotScope,
  type ManagerLiveRefreshScope,
} from '../../src/domain/manager-live-refresh';

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
});
