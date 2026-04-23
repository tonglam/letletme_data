import { describe, expect, it } from 'bun:test';

import type { Event, Fixture } from '../../src/types';
import { isAfterMatchDay, isMatchDayTime } from '../../src/utils/conditions';

function buildEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 1,
    name: 'GW1',
    deadlineTime: null,
    averageEntryScore: null,
    finished: false,
    dataChecked: false,
    highestScoringEntry: null,
    deadlineTimeEpoch: null,
    deadlineTimeGameOffset: null,
    highestScore: null,
    isPrevious: false,
    isCurrent: true,
    isNext: false,
    cupLeagueCreate: false,
    h2hKoMatchesCreated: false,
    chipPlays: null,
    mostSelected: null,
    mostTransferredIn: null,
    topElement: null,
    topElementInfo: null,
    transfersMade: null,
    mostCaptained: null,
    mostViceCaptained: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

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

describe('isMatchDayTime', () => {
  it('returns true only during each fixture window', () => {
    const event = buildEvent();
    const fixtures = [
      buildFixture('2026-04-20T18:00:00.000Z', 101),
      buildFixture('2026-04-22T18:00:00.000Z', 102),
    ];

    expect(isMatchDayTime(event, fixtures, new Date('2026-04-20T19:00:00.000Z'))).toBe(true);
    expect(isMatchDayTime(event, fixtures, new Date('2026-04-20T20:30:00.000Z'))).toBe(false);
    expect(isMatchDayTime(event, fixtures, new Date('2026-04-22T19:00:00.000Z'))).toBe(true);
  });

  it('includes the exact fixture boundaries', () => {
    const event = buildEvent();
    const fixtures = [buildFixture('2026-04-20T18:00:00.000Z', 201)];

    expect(isMatchDayTime(event, fixtures, new Date('2026-04-20T18:00:00.000Z'))).toBe(true);
    expect(isMatchDayTime(event, fixtures, new Date('2026-04-20T20:00:00.000Z'))).toBe(true);
    expect(isMatchDayTime(event, fixtures, new Date('2026-04-20T20:00:00.001Z'))).toBe(false);
  });

  it('keeps window open when finish flag is delayed', () => {
    const event = buildEvent();
    const fixtures: Fixture[] = [
      {
        ...buildFixture('2026-04-20T18:00:00.000Z', 210),
        started: true,
        finished: false,
      },
    ];

    // beyond nominal +2h, but within delayed-finish grace
    expect(isMatchDayTime(event, fixtures, new Date('2026-04-20T21:00:00.000Z'))).toBe(true);
    // beyond hard cap (+6h)
    expect(isMatchDayTime(event, fixtures, new Date('2026-04-21T00:00:00.001Z'))).toBe(false);
  });
});

describe('isAfterMatchDay', () => {
  it('uses the final fixture window end', () => {
    const event = buildEvent();
    const fixtures = [
      buildFixture('2026-04-20T18:00:00.000Z', 301),
      buildFixture('2026-04-22T18:00:00.000Z', 302),
    ];

    expect(isAfterMatchDay(event, fixtures, new Date('2026-04-22T19:59:59.999Z'))).toBe(false);
    expect(isAfterMatchDay(event, fixtures, new Date('2026-04-22T20:00:00.001Z'))).toBe(true);
  });
});
