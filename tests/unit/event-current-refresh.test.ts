import { describe, expect, test } from 'bun:test';

import {
  coreLifecycleReconcilePeriodKey,
  coreSnapshotRefreshReason,
} from '../../src/domain/core-snapshot-refresh';

const current = {
  id: 1,
  isPrevious: false,
  isCurrent: false,
  isNext: true,
  finished: false,
  dataChecked: false,
};

const scheduledFixture = {
  id: 101,
  event: 1,
  kickoffTime: new Date('2026-08-22T19:00:00.000Z'),
  started: false,
  finished: false,
  finishedProvisional: false,
};

function publication(fixture = scheduledFixture) {
  return {
    currentEventId: 1,
    events: [current],
    fixtures: [fixture],
  };
}

describe('event current refresh lifecycle comparison', () => {
  test('opens a new durable obligation for each canonical lifecycle transition', () => {
    const scheduledKey = coreLifecycleReconcilePeriodKey(
      current,
      [scheduledFixture],
      'kickoff-cutover',
    );
    const repeatedKey = coreLifecycleReconcilePeriodKey(
      current,
      [scheduledFixture],
      'kickoff-cutover',
    );
    const startedKey = coreLifecycleReconcilePeriodKey(
      current,
      [{ ...scheduledFixture, started: true }],
      'fixture-lifecycle',
    );
    const provisionalKey = coreLifecycleReconcilePeriodKey(
      current,
      [{ ...scheduledFixture, started: true, finishedProvisional: true }],
      'fixture-lifecycle',
    );

    expect(repeatedKey).toBe(scheduledKey);
    expect(startedKey).not.toBe(scheduledKey);
    expect(provisionalKey).not.toBe(startedKey);
  });

  test('forces a core refresh at kickoff even when the current event id is unchanged', () => {
    expect(
      coreSnapshotRefreshReason(
        current,
        [scheduledFixture],
        publication(),
        new Date('2026-08-22T19:00:01.000Z'),
      ),
    ).toBe('kickoff-cutover');
  });

  test('detects a durable live fixture that has not reached the core publication', () => {
    expect(
      coreSnapshotRefreshReason(
        current,
        [{ ...scheduledFixture, started: true }],
        publication(),
        new Date('2026-08-22T19:01:00.000Z'),
      ),
    ).toBe('fixture-lifecycle');
  });

  test('stops refreshing after the core fixture lifecycle catches up', () => {
    const started = { ...scheduledFixture, started: true };
    expect(
      coreSnapshotRefreshReason(
        current,
        [started],
        publication(started),
        new Date('2026-08-22T19:01:00.000Z'),
      ),
    ).toBeNull();
  });

  test('bounds kickoff-only repair when a scheduled fixture is postponed upstream', () => {
    expect(
      coreSnapshotRefreshReason(
        current,
        [scheduledFixture],
        publication(),
        new Date('2026-08-22T19:20:00.000Z'),
      ),
    ).toBeNull();
  });
});
