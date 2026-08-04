import { describe, expect, test } from 'bun:test';

import {
  findOmittedEventFixtureIds,
  resolveFixtureCacheLockEventIds,
  resolveFixtureDerivativeReconciliationEventIds,
  resolveFixtureCacheTransitions,
} from '../../src/domain/fixture-cache-transition';

describe('event-scoped fixture coverage', () => {
  test('detects persisted fixtures omitted after moving out of an event', () => {
    expect(
      findOmittedEventFixtureIds(
        10,
        [
          { id: 101, event: 10 },
          { id: 102, event: 10 },
          { id: 103, event: 11 },
        ],
        new Set([102, 103]),
      ),
    ).toEqual([101]);
  });
});

describe('fixture cache transitions', () => {
  test('reconciles historical owned snapshots plus represented compatibility events', () => {
    expect(
      resolveFixtureDerivativeReconciliationEventIds(
        [1, 2, 3, 4],
        [3, 1, 3, 99],
        [2, null, undefined, 99],
      ),
    ).toEqual([1, 2, 3]);
  });

  test('locks every accepted destination even when ownership is unchanged', () => {
    expect(
      resolveFixtureCacheLockEventIds(
        [
          { id: 101, event: 10 },
          { id: 102, event: 11 },
          { id: 103, event: null },
        ],
        new Set([9, 10]),
      ),
    ).toEqual([9, 10, 11]);
  });

  test('retires the prior event when a fixture moves to another event', () => {
    const transitions = resolveFixtureCacheTransitions(
      [{ id: 101, event: 11 }],
      new Map([[101, 10]]),
    );

    expect([...transitions.invalidatedEventIds]).toEqual([10, 11]);
    expect([...transitions.unscheduledFixtureIdsToRemove]).toEqual([]);
  });

  test('retires the prior event when a fixture becomes unscheduled', () => {
    const transitions = resolveFixtureCacheTransitions(
      [{ id: 101, event: null }],
      new Map([[101, 10]]),
    );

    expect([...transitions.invalidatedEventIds]).toEqual([10]);
    expect([...transitions.unscheduledFixtureIdsToRemove]).toEqual([]);
  });

  test('removes only the reassigned fixture from the unscheduled bucket', () => {
    const transitions = resolveFixtureCacheTransitions(
      [{ id: 101, event: 10 }],
      new Map([[101, null]]),
    );

    expect([...transitions.invalidatedEventIds]).toEqual([10]);
    expect([...transitions.unscheduledFixtureIdsToRemove]).toEqual([101]);
  });

  test('ignores unchanged ownership and invalidates a newly assigned destination', () => {
    const transitions = resolveFixtureCacheTransitions(
      [
        { id: 101, event: 10 },
        { id: 102, event: 11 },
      ],
      new Map([[101, 10]]),
    );

    expect([...transitions.invalidatedEventIds]).toEqual([11]);
    expect([...transitions.unscheduledFixtureIdsToRemove]).toEqual([]);
  });
});
