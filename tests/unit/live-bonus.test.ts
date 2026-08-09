import { describe, expect, it } from 'bun:test';

import {
  calculateFixtureBonus,
  computeFixtureSummedBonusByTeam,
  validateLiveBonusCachePayload,
} from '../../src/domain/live-bonus';

const fixtureStats = (
  teamH: number,
  teamA: number,
  bps: { h: Array<[number, number]>; a: Array<[number, number]> },
  bonus?: { h: Array<[number, number]>; a: Array<[number, number]> },
  finished = false,
) => ({
  teamH,
  teamA,
  started: true,
  finished,
  finishedProvisional: finished,
  stats: [
    {
      identifier: 'bps',
      h: bps.h.map(([element, value]) => ({ element, value })),
      a: bps.a.map(([element, value]) => ({ element, value })),
    },
    ...(bonus
      ? [
          {
            identifier: 'bonus',
            h: bonus.h.map(([element, value]) => ({ element, value })),
            a: bonus.a.map(([element, value]) => ({ element, value })),
          },
        ]
      : []),
  ],
});

describe('calculateFixtureBonus', () => {
  const candidate = (elementId: number, teamId: number, value: number) => ({
    elementId,
    teamId,
    value,
  });

  it('awards 3/2/1 across both teams of one fixture', () => {
    expect(
      calculateFixtureBonus([
        candidate(11, 1, 30),
        candidate(12, 1, 25),
        candidate(21, 2, 20),
        candidate(22, 2, 10),
      ]),
    ).toEqual(
      new Map([
        [11, 3],
        [12, 2],
        [21, 1],
      ]),
    );
  });

  it('applies FPL tie tiers without inventing a fourth award', () => {
    expect(
      calculateFixtureBonus([
        candidate(11, 1, 30),
        candidate(21, 2, 30),
        candidate(12, 1, 20),
        candidate(22, 2, 10),
      ]),
    ).toEqual(
      new Map([
        [11, 3],
        [21, 3],
        [12, 1],
      ]),
    );
  });

  it('awards three tied leaders 3 each and stops', () => {
    expect(
      calculateFixtureBonus([
        candidate(11, 1, 30),
        candidate(21, 2, 30),
        candidate(12, 1, 30),
        candidate(22, 2, 20),
      ]),
    ).toEqual(
      new Map([
        [11, 3],
        [21, 3],
        [12, 3],
      ]),
    );
  });

  it('awards a tied runner-up tier 2 each and omits the 1-point tier', () => {
    expect(
      calculateFixtureBonus([
        candidate(11, 1, 30),
        candidate(21, 2, 25),
        candidate(12, 1, 25),
        candidate(22, 2, 10),
      ]),
    ).toEqual(
      new Map([
        [11, 3],
        [21, 2],
        [12, 2],
      ]),
    );
  });

  it('returns no awards without positive BPS', () => {
    expect(calculateFixtureBonus([candidate(11, 1, 0), candidate(21, 2, -1)])).toEqual(new Map());
  });
});

describe('computeFixtureSummedBonusByTeam', () => {
  it('sums fixture-scoped official awards across a double gameweek', () => {
    const result = computeFixtureSummedBonusByTeam([
      fixtureStats(1, 2, { h: [[10, 30]], a: [[20, 20]] }, { h: [[10, 3]], a: [[20, 2]] }, true),
      fixtureStats(1, 3, { h: [[10, 40]], a: [[30, 20]] }, { h: [[10, 2]], a: [[30, 3]] }, true),
    ]);

    expect(result.get(1)?.get(10)).toBe(5);
    expect(result.get(2)?.get(20)).toBe(2);
    expect(result.get(3)?.get(30)).toBe(3);
    expect(() =>
      validateLiveBonusCachePayload({ eventId: 1, byTeam: { '1': { '10': 5 } } }),
    ).not.toThrow();
  });

  it('uses provisional fixture BPS only until official bonus is present', () => {
    const provisional = computeFixtureSummedBonusByTeam([
      fixtureStats(1, 2, {
        h: [[10, 50]],
        a: [
          [20, 40],
          [21, 30],
        ],
      }),
    ]);
    expect(provisional.get(1)?.get(10)).toBe(3);
    expect(provisional.get(2)?.get(20)).toBe(2);
    expect(provisional.get(2)?.get(21)).toBe(1);

    const official = computeFixtureSummedBonusByTeam([
      fixtureStats(1, 2, { h: [[10, 50]], a: [[20, 40]] }, { h: [], a: [[20, 3]] }, true),
    ]);
    expect(official.get(1)?.get(10)).toBeUndefined();
    expect(official.get(2)?.get(20)).toBe(3);
  });

  it('does not revive provisional awards for a settled fixture with no bonus rows', () => {
    const result = computeFixtureSummedBonusByTeam([
      fixtureStats(1, 2, { h: [[10, 50]], a: [[20, 40]] }, undefined, true),
    ]);
    expect(result.size).toBe(0);
  });

  it('ignores fixtures which have not started', () => {
    const fixture = fixtureStats(1, 2, { h: [[10, 50]], a: [[20, 40]] });
    const result = computeFixtureSummedBonusByTeam([
      { ...fixture, started: false, finished: false, finishedProvisional: false },
    ]);
    expect(result.size).toBe(0);
  });
});
