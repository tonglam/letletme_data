import { describe, expect, test } from 'bun:test';

import { reconcileCoreFixtureDerivatives } from '../../src/services/core-fixture-derivatives.service';

import type { Fixture } from '../../src/types';

function fixture(event: number): Fixture {
  return {
    id: 100 + event,
    code: 100 + event,
    event,
    finished: false,
    finishedProvisional: false,
    kickoffTime: new Date('2026-08-15T12:00:00.000Z'),
    minutes: 0,
    provisionalStartTime: false,
    started: false,
    teamA: 1,
    teamAScore: null,
    teamH: 2,
    teamHScore: null,
    stats: [],
    teamHDifficulty: 2,
    teamADifficulty: 3,
    pulseId: 100 + event,
    createdAt: null,
    updatedAt: null,
  };
}

describe('core fixture derivative reconciliation', () => {
  test('checks canonical fixture rows through the coordinated ownership adapter', async () => {
    const refreshed: Array<{ eventId: number; fixtureIds: number[] }> = [];
    const requestedFixtureIds: number[][] = [];
    const serializedEventIds: number[][] = [];
    const result = await reconcileCoreFixtureDerivatives(
      [112],
      new Date('2026-08-04T00:00:00.000Z'),
      {
        findByIds: async (fixtureIds) => {
          requestedFixtureIds.push([...fixtureIds]);
          return [fixture(12)];
        },
        coordinator: {
          retire: async (eventId) => ({ eventId, removedKeys: 0 }),
          refreshFixtureDerivatives: async (eventId, fixtures) => {
            refreshed.push({ eventId, fixtureIds: fixtures.map((item) => item.id) });
            return { eventId, owned: true, retired: true };
          },
        },
        serializeEvents: async (eventIds, operation) => {
          serializedEventIds.push([...eventIds]);
          await operation();
        },
      },
    );

    expect(result).toEqual({ checkedEvents: 38, retiredEmptyEvents: 0 });
    expect(requestedFixtureIds).toEqual([[112]]);
    expect(serializedEventIds).toEqual([Array.from({ length: 38 }, (_, index) => index + 1)]);
    expect(refreshed).toEqual([{ eventId: 12, fixtureIds: [112] }]);
  });

  test('retires empty event views even when no ownership metadata exists', async () => {
    const retired: number[] = [];
    const result = await reconcileCoreFixtureDerivatives([], new Date('2026-08-04T00:00:00.000Z'), {
      findByIds: async () => [],
      coordinator: {
        retire: async (eventId) => {
          retired.push(eventId);
          return { eventId, removedKeys: eventId === 12 ? 7 : 0 };
        },
        refreshFixtureDerivatives: async (eventId) => ({
          eventId,
          owned: false,
          retired: false,
        }),
      },
      serializeEvents: async (_eventIds, operation) => operation(),
    });

    expect(result).toEqual({ checkedEvents: 38, retiredEmptyEvents: 1 });
    expect(retired).toEqual(Array.from({ length: 38 }, (_, index) => index + 1));
  });
});
