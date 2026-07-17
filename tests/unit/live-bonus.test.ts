import { describe, expect, it } from 'bun:test';

import {
  buildPlayingMatches,
  calculateMatchBonus,
  computeLiveBonusByTeam,
  type BonusEligibleLive,
} from '../../src/domain/live-bonus';
import type { LiveFixtureData, LiveFixturesByTeam } from '../../src/domain/live-fixtures';

/**
 * FP-11 (H7): bonus is awarded per MATCH (top 3 BPS across both teams,
 * max 6 points), not per team; fixture pairing must survive double
 * gameweeks.
 */

function live(elementId: number, teamId: number, bps: number | null, bonus = 0): BonusEligibleLive {
  return { elementId, teamId, minutes: 90, bps, bonus };
}

function fixture(teamId: number, againstId: number): LiveFixtureData {
  return {
    teamId,
    teamName: `Team ${teamId}`,
    teamShortName: `T${teamId}`,
    teamScore: 0,
    teamPosition: teamId,
    againstId,
    againstName: `Team ${againstId}`,
    againstShortName: `T${againstId}`,
    againstTeamScore: 0,
    againstTeamPosition: againstId,
    kickoffTime: null,
    score: '0 - 0',
    wasHome: true,
    started: true,
    finished: false,
  };
}

function fixturesByTeam(entries: Record<number, LiveFixtureData[]>): LiveFixturesByTeam {
  const result: Record<string, LiveFixturesByTeam[string]> = {};
  for (const [teamId, fixtures] of Object.entries(entries)) {
    result[teamId] = { Playing: fixtures, Not_Start: [], Finished: [] };
  }
  return result;
}

describe('buildPlayingMatches', () => {
  it('pairs both directions of a fixture into one match', () => {
    const matches = buildPlayingMatches(fixturesByTeam({ 1: [fixture(1, 2)], 2: [fixture(2, 1)] }));
    expect(matches).toEqual([{ teamA: 1, teamB: 2 }]);
  });

  it('maps every fixture of a double-gameweek team, not just the first', () => {
    const matches = buildPlayingMatches(
      fixturesByTeam({
        1: [fixture(1, 2), fixture(1, 3)],
        2: [fixture(2, 1)],
        3: [fixture(3, 1)],
        4: [fixture(4, 5)],
        5: [fixture(5, 4)],
      }),
    );
    expect(matches).toHaveLength(3);
    expect(matches).toContainEqual({ teamA: 1, teamB: 2 });
    expect(matches).toContainEqual({ teamA: 1, teamB: 3 });
    expect(matches).toContainEqual({ teamA: 4, teamB: 5 });
  });

  it('returns no matches for null or fixture-less input', () => {
    expect(buildPlayingMatches(null)).toEqual([]);
    expect(buildPlayingMatches(fixturesByTeam({ 1: [] }))).toEqual([]);
  });
});

describe('calculateMatchBonus', () => {
  it('awards 3/2/1 across the combined bucket', () => {
    const bonus = calculateMatchBonus([
      live(11, 1, 30),
      live(12, 1, 25),
      live(21, 2, 20),
      live(22, 2, 10),
    ]);
    expect(bonus.get(11)).toBe(3);
    expect(bonus.get(12)).toBe(2);
    expect(bonus.get(21)).toBe(1);
    expect(bonus.get(22)).toBeUndefined();
  });

  it('gives two tied leaders 3 each and the next player 1', () => {
    const bonus = calculateMatchBonus([live(11, 1, 30), live(21, 2, 30), live(12, 1, 20)]);
    expect(bonus.get(11)).toBe(3);
    expect(bonus.get(21)).toBe(3);
    expect(bonus.get(12)).toBe(1);
  });

  it('gives three tied leaders 3 each and stops', () => {
    const bonus = calculateMatchBonus([
      live(11, 1, 30),
      live(21, 2, 30),
      live(12, 1, 30),
      live(22, 2, 20),
    ]);
    expect(bonus.get(11)).toBe(3);
    expect(bonus.get(21)).toBe(3);
    expect(bonus.get(12)).toBe(3);
    expect(bonus.get(22)).toBeUndefined();
  });

  it('gives one leader 3 and a tied runner-up tier 2 each', () => {
    const bonus = calculateMatchBonus([
      live(11, 1, 30),
      live(21, 2, 25),
      live(12, 1, 25),
      live(22, 2, 10),
    ]);
    expect(bonus.get(11)).toBe(3);
    expect(bonus.get(21)).toBe(2);
    expect(bonus.get(12)).toBe(2);
    expect(bonus.get(22)).toBeUndefined();
  });

  it('ignores players with no positive BPS', () => {
    const bonus = calculateMatchBonus([live(11, 1, 0), live(21, 2, null)]);
    expect(bonus.size).toBe(0);
  });
});

describe('computeLiveBonusByTeam', () => {
  it('distributes exactly 6 bonus points across both teams of a match', () => {
    const byTeam = computeLiveBonusByTeam(
      [{ teamA: 1, teamB: 2 }],
      [live(11, 1, 30), live(12, 1, 25), live(13, 1, 15), live(21, 2, 20), live(22, 2, 10)],
    );

    // Combined ranking: 11 (30) -> 3, 12 (25) -> 2, 21 (20) -> 1
    expect(byTeam.get(1)).toEqual(
      new Map([
        [11, 3],
        [12, 2],
      ]),
    );
    expect(byTeam.get(2)).toEqual(new Map([[21, 1]]));

    const total = [...byTeam.values()].flatMap((m) => [...m.values()]).reduce((a, b) => a + b, 0);
    expect(total).toBe(6);
  });

  it('skips players with zero minutes', () => {
    const byTeam = computeLiveBonusByTeam(
      [{ teamA: 1, teamB: 2 }],
      [{ ...live(11, 1, 40), minutes: 0 }, live(21, 2, 20)],
    );
    expect(byTeam.get(1)).toBeUndefined();
    expect(byTeam.get(2)).toEqual(new Map([[21, 3]]));
  });

  it('uses FPL-assigned bonus values when a match is already settled', () => {
    const byTeam = computeLiveBonusByTeam(
      [{ teamA: 1, teamB: 2 }],
      [live(11, 1, 99, 3), live(12, 1, 50, 2), live(21, 2, 80, 1), live(22, 2, 70, 0)],
    );
    expect(byTeam.get(1)).toEqual(
      new Map([
        [11, 3],
        [12, 2],
      ]),
    );
    expect(byTeam.get(2)).toEqual(new Map([[21, 1]]));
  });

  it('ranks a double-gameweek player in each fixture and keeps the best award', () => {
    const matches = buildPlayingMatches(
      fixturesByTeam({ 1: [fixture(1, 2), fixture(1, 3)], 2: [fixture(2, 1)], 3: [fixture(3, 1)] }),
    );
    const byTeam = computeLiveBonusByTeam(matches, [
      live(11, 1, 30), // DGW player: top BPS in both matches
      live(21, 2, 20),
      live(31, 3, 25),
    ]);

    expect(matches).toHaveLength(2);
    // Best single-match award is 3 (shape caps at 0–3), never 3+3
    expect(byTeam.get(1)).toEqual(new Map([[11, 3]]));
    expect(byTeam.get(2)).toEqual(new Map([[21, 2]]));
    expect(byTeam.get(3)).toEqual(new Map([[31, 2]]));
  });
});
