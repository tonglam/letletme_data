import { describe, expect, test } from 'bun:test';

import { resolveFixtureCacheTransitions } from '../../src/domain/fixture-cache-transition';

describe('fixture cache transitions', () => {
  test('retires the prior event when a fixture moves to another event', () => {
    const transitions = resolveFixtureCacheTransitions(
      [{ id: 101, event: 11 }],
      new Map([[101, 10]]),
    );

    expect([...transitions.staleEventIds]).toEqual([10]);
    expect(transitions.shouldClearUnscheduled).toBe(false);
  });

  test('retires the prior event when a fixture becomes unscheduled', () => {
    const transitions = resolveFixtureCacheTransitions(
      [{ id: 101, event: null }],
      new Map([[101, 10]]),
    );

    expect([...transitions.staleEventIds]).toEqual([10]);
    expect(transitions.shouldClearUnscheduled).toBe(false);
  });

  test('clears the unscheduled bucket when a fixture gains an event', () => {
    const transitions = resolveFixtureCacheTransitions(
      [{ id: 101, event: 10 }],
      new Map([[101, null]]),
    );

    expect([...transitions.staleEventIds]).toEqual([]);
    expect(transitions.shouldClearUnscheduled).toBe(true);
  });

  test('ignores unchanged and previously unknown fixture ownership', () => {
    const transitions = resolveFixtureCacheTransitions(
      [
        { id: 101, event: 10 },
        { id: 102, event: 11 },
      ],
      new Map([[101, 10]]),
    );

    expect([...transitions.staleEventIds]).toEqual([]);
    expect(transitions.shouldClearUnscheduled).toBe(false);
  });
});
