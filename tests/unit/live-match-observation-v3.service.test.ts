import { describe, expect, mock, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';
import {
  syncLiveMatchObservationV3,
  type LiveMatchObservationV3Dependencies,
} from '../../src/services/live-match-observation-v3.service';
import type { LiveSnapshotReferenceData } from '../../src/services/live-coherent-fetch';
import type { LiveMatchObservationResult } from '../../src/services/live-match-v3.service';

const observationResult = {} as LiveMatchObservationResult;

describe('Live Matches V3 match-only observation', () => {
  test('publishes a fixture-only desk without introducing an event-live dependency', async () => {
    let received: Record<string, unknown> | undefined;
    const callOrder: string[] = [];
    const dependencies: LiveMatchObservationV3Dependencies = {
      getFixtures: mock(async () => {
        callOrder.push('fixtures');
        return [];
      }),
      getCore: mock(async () => ({ fixtures: [{ id: 19, event: 12 }] }) as never),
      getDeskFence: mock(async () => {
        callOrder.push('desk-fence');
        return { observed: 'desk-pointer-before-fetch', read: null };
      }),
      getReferenceData: mock(async () => ({}) as LiveSnapshotReferenceData),
      syncMatches: mock(async (input) => {
        received = input as unknown as Record<string, unknown>;
        return observationResult;
      }),
    };

    await syncLiveMatchObservationV3(TEST_SEASON, 12, {
      lifecycleState: 'PRE_DEADLINE',
      expectedNextCheckAt: '2026-09-01T00:02:00.000Z',
      dependencies,
    });

    expect(received).toMatchObject({
      season: TEST_SEASON,
      eventId: 12,
      rawFixtures: [],
      expectedFixtureIds: [19],
      observedDesk: { observed: 'desk-pointer-before-fetch', read: null },
      lifecycleState: 'PRE_DEADLINE',
      expectedNextCheckAt: '2026-09-01T00:02:00.000Z',
    });
    expect(received).not.toHaveProperty('rawEventLive');
    expect(dependencies.getFixtures).toHaveBeenCalledTimes(1);
    expect(dependencies.getCore).toHaveBeenCalledWith(TEST_SEASON.seasonCode);
    expect(dependencies.getDeskFence).toHaveBeenCalledWith(TEST_SEASON.seasonCode, 12);
    expect(callOrder).toEqual(['desk-fence', 'fixtures']);
  });

  test('fails closed when neither Core nor the existing desk provides fixture identity', async () => {
    const dependencies: LiveMatchObservationV3Dependencies = {
      getFixtures: mock(async () => []),
      getCore: mock(async () => null),
      getDeskFence: mock(async () => ({ observed: '', read: null })),
      getReferenceData: mock(async () => ({}) as LiveSnapshotReferenceData),
      syncMatches: mock(async () => observationResult),
    };

    await expect(syncLiveMatchObservationV3(TEST_SEASON, 12, { dependencies })).rejects.toThrow(
      'fixture identity authority is unavailable',
    );
    expect(dependencies.syncMatches).not.toHaveBeenCalled();
  });
});
