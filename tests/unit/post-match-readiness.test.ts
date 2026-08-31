import { describe, expect, mock, test } from 'bun:test';

import {
  getPostMatchResultsCheckpoint,
  getPostMatchResultsSlot,
  POST_MATCH_RESULTS_WINDOW_MS,
} from '../../src/domain/post-match-results';
import {
  isTournamentCascadeFinalizedEvent,
  shouldEnqueueTournamentCascade,
} from '../../src/domain/tournament-event-results';
import {
  resolvePlayerValuesSyncDecision,
  shouldRunPlayerValuesSync,
} from '../../src/jobs/player-values-window.jobs';
import type { Event, Fixture } from '../../src/types';

function buildFixture(kickoffIso: string, id: number): Fixture {
  return {
    id,
    code: id,
    event: 1,
    finished: false,
    finishedProvisional: false,
    kickoffTime: new Date(kickoffIso),
    minutes: 0,
    provisionalStartTime: false,
    started: null,
    teamA: 1,
    teamAScore: null,
    teamH: 2,
    teamHScore: null,
    stats: [],
    teamHDifficulty: null,
    teamADifficulty: null,
    pulseId: id,
    createdAt: null,
    updatedAt: null,
  };
}

describe('bounded post-match result slots', () => {
  const fixtures = [
    buildFixture('2026-08-22T14:00:00.000Z', 1),
    buildFixture('2026-08-22T18:00:00.000Z', 2),
  ];

  test('does not open until the final fixture nominally ends', () => {
    expect(
      getPostMatchResultsSlot(
        { dataChecked: false },
        fixtures,
        new Date('2026-08-22T19:59:59.999Z'),
      ),
    ).toBeNull();
  });

  test('maps all cron ticks in an hour to one deterministic provisional slot', () => {
    expect(
      getPostMatchResultsSlot(
        { dataChecked: false },
        fixtures,
        new Date('2026-08-22T20:10:00.000Z'),
      ),
    ).toBe('provisional-0');
    expect(
      getPostMatchResultsSlot(
        { dataChecked: false },
        fixtures,
        new Date('2026-08-22T20:50:00.000Z'),
      ),
    ).toBe('provisional-0');
    expect(
      getPostMatchResultsSlot(
        { dataChecked: false },
        fixtures,
        new Date('2026-08-22T21:00:00.000Z'),
      ),
    ).toBe('provisional-1');
  });

  test('anchors every checkpoint to the immutable start of its hourly slot', () => {
    expect(
      getPostMatchResultsCheckpoint(
        { dataChecked: false },
        fixtures,
        new Date('2026-08-22T20:50:00.000Z'),
      ),
    ).toEqual({
      slot: 'provisional-0',
      dueAt: new Date('2026-08-22T20:00:00.000Z'),
    });
    expect(
      getPostMatchResultsCheckpoint(
        { dataChecked: false },
        fixtures,
        new Date('2026-08-22T21:35:00.000Z'),
      ),
    ).toEqual({
      slot: 'provisional-1',
      dueAt: new Date('2026-08-22T21:00:00.000Z'),
    });
  });

  test('keeps final slots hourly after FPL checks the event data', () => {
    expect(
      getPostMatchResultsSlot(
        { dataChecked: true },
        fixtures,
        new Date('2026-08-22T22:00:00.000Z'),
      ),
    ).toBe('final-2');
    expect(
      getPostMatchResultsSlot(
        { dataChecked: true },
        fixtures,
        new Date('2026-08-22T22:50:00.000Z'),
      ),
    ).toBe('final-2');
    expect(
      getPostMatchResultsSlot(
        { dataChecked: true },
        fixtures,
        new Date('2026-08-22T23:00:00.000Z'),
      ),
    ).toBe('final-3');
  });

  test('keeps the GW38 final window open on the next UTC day', () => {
    const gw38Fixtures = [buildFixture('2027-05-23T18:00:00.000Z', 38)];

    expect(
      getPostMatchResultsSlot(
        { dataChecked: true },
        gw38Fixtures,
        new Date('2027-05-24T06:35:00.000Z'),
      ),
    ).toBe('final-10');
  });

  test('closes after 24 hours and rejects missing or invalid kickoff data', () => {
    const matchEndMs = new Date('2026-08-22T20:00:00.000Z').getTime();
    expect(
      getPostMatchResultsSlot(
        { dataChecked: false },
        fixtures,
        new Date(matchEndMs + POST_MATCH_RESULTS_WINDOW_MS),
      ),
    ).toBeNull();
    expect(getPostMatchResultsSlot({ dataChecked: false }, [], new Date())).toBeNull();
    expect(
      getPostMatchResultsSlot({ dataChecked: false }, [buildFixture('invalid', 3)], new Date()),
    ).toBeNull();
  });
});

describe('player-values player-event guard', () => {
  test('does not query daily values when there is no current or next event', async () => {
    const hasChangesForDate = mock(async () => false);
    const shouldRun = await shouldRunPlayerValuesSync(new Date('2026-08-21T01:25:00.000Z'), {
      resolvePlayerSyncEvent: async () => null,
      hasChangesForDate,
    });

    expect(shouldRun).toBe(false);
    expect(hasChangesForDate).not.toHaveBeenCalled();
  });

  test('polls a current event until today has been recorded', async () => {
    const date = new Date('2026-08-22T01:25:00.000Z');
    const resolvePlayerEvent = async () => ({
      event: { id: 1 } as Event,
      phase: 'current' as const,
    });

    expect(
      await shouldRunPlayerValuesSync(date, {
        resolvePlayerSyncEvent: resolvePlayerEvent,
        hasChangesForDate: async () => true,
      }),
    ).toBe(false);
    expect(
      await shouldRunPlayerValuesSync(date, {
        resolvePlayerSyncEvent: resolvePlayerEvent,
        hasChangesForDate: async () => false,
      }),
    ).toBe(true);
  });

  test('allows only the 06:55 tick before GW1', async () => {
    const dependencies = {
      resolvePlayerSyncEvent: async () => ({
        event: { id: 1 } as Event,
        phase: 'preseason' as const,
      }),
      hasChangesForDate: async () => false,
    };

    expect(
      await shouldRunPlayerValuesSync(new Date('2026-08-21T22:55:00.000Z'), dependencies),
    ).toBe(true);
    expect(
      await shouldRunPlayerValuesSync(new Date('2026-08-21T22:56:00.000Z'), dependencies),
    ).toBe(false);
  });

  test('marks an in-season capture as retryable until the final window minute', async () => {
    const dependencies = {
      resolvePlayerSyncEvent: async () => ({
        event: { id: 1 } as Event,
        phase: 'current' as const,
      }),
      hasChangesForDate: async () => false,
    };

    await expect(
      resolvePlayerValuesSyncDecision(new Date('2026-08-21T22:55:00.000Z'), dependencies),
    ).resolves.toEqual({ shouldRun: true, pollUntilWindowEnd: true });
  });
});

describe('empty tournament result sync', () => {
  test('does not fan out a cascade when there are no active entries', () => {
    expect(shouldEnqueueTournamentCascade({ totalEntries: 0 })).toBe(false);
    expect(shouldEnqueueTournamentCascade({ totalEntries: 2 })).toBe(true);
  });
});

describe('tournament cascade finalization fence', () => {
  test('requires exact finished, data_checked, and data_checked_at evidence', () => {
    expect(
      isTournamentCascadeFinalizedEvent({
        finished: false,
        dataChecked: true,
        dataCheckedAt: new Date('2026-08-22T22:00:00.000Z'),
      }),
    ).toBe(false);
    expect(
      isTournamentCascadeFinalizedEvent({
        finished: true,
        dataChecked: true,
        dataCheckedAt: null,
      }),
    ).toBe(false);
    expect(
      isTournamentCascadeFinalizedEvent({
        finished: true,
        dataChecked: true,
        dataCheckedAt: new Date('2026-08-22T22:00:00.000Z'),
      }),
    ).toBe(true);
  });
});
