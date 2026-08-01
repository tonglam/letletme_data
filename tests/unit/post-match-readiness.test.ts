import { describe, expect, mock, test } from 'bun:test';

import {
  getPostMatchResultsSlot,
  POST_MATCH_RESULTS_WINDOW_MS,
} from '../../src/domain/post-match-results';
import { shouldEnqueueTournamentCascade } from '../../src/domain/tournament-event-results';
import { shouldRunCurrentEventJob } from '../../src/jobs/current-event-gate';
import { shouldRunPlayerValuesSync } from '../../src/jobs/player-values-window.jobs';
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

  test('uses one final slot after FPL checks the event data', () => {
    expect(
      getPostMatchResultsSlot(
        { dataChecked: true },
        fixtures,
        new Date('2026-08-22T22:00:00.000Z'),
      ),
    ).toBe('final');
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

describe('current-event job gate', () => {
  test('does not look up a current event outside the season window', async () => {
    const isFPLSeason = mock(async () => false);
    const getCurrentEvent = mock(async () => null);

    expect(
      await shouldRunCurrentEventJob('player-stats-sync', new Date(), {
        isFPLSeason,
        getCurrentEvent,
      }),
    ).toBe(false);
    expect(getCurrentEvent).not.toHaveBeenCalled();
  });

  test('skips jobs until a current event exists', async () => {
    expect(
      await shouldRunCurrentEventJob('player-stats-sync', new Date(), {
        isFPLSeason: async () => true,
        getCurrentEvent: async () => null,
      }),
    ).toBe(false);
  });

  test('allows jobs once the season and current event are both active', async () => {
    expect(
      await shouldRunCurrentEventJob('player-stats-sync', new Date(), {
        isFPLSeason: async () => true,
        getCurrentEvent: async () => ({ id: 1 }) as Event,
      }),
    ).toBe(true);
  });
});

describe('player-values current-event guard', () => {
  test('does not query daily values when there is no current event', async () => {
    const hasChangesForDate = mock(async () => false);
    const shouldRun = await shouldRunPlayerValuesSync(new Date('2026-08-21T01:25:00.000Z'), {
      shouldRunCurrentEventJob: async () => false,
      hasChangesForDate,
    });

    expect(shouldRun).toBe(false);
    expect(hasChangesForDate).not.toHaveBeenCalled();
  });

  test('runs only when a current event exists and today has not been recorded', async () => {
    const date = new Date('2026-08-22T01:25:00.000Z');
    const shouldRunCurrentEvent = async () => true;

    expect(
      await shouldRunPlayerValuesSync(date, {
        shouldRunCurrentEventJob: shouldRunCurrentEvent,
        hasChangesForDate: async () => true,
      }),
    ).toBe(false);
    expect(
      await shouldRunPlayerValuesSync(date, {
        shouldRunCurrentEventJob: shouldRunCurrentEvent,
        hasChangesForDate: async () => false,
      }),
    ).toBe(true);
  });
});

describe('empty tournament result sync', () => {
  test('does not fan out a cascade when there are no active entries', () => {
    expect(shouldEnqueueTournamentCascade({ totalEntries: 0 })).toBe(false);
    expect(shouldEnqueueTournamentCascade({ totalEntries: 2 })).toBe(true);
  });
});
