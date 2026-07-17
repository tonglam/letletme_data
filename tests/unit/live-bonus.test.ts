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

function fixture(
  teamId: number,
  againstId: number,
  kickoffTime: string | null = null,
  finished = false,
): LiveFixtureData {
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
    kickoffTime,
    score: '0 - 0',
    wasHome: true,
    started: true,
    finished,
  };
}

function match(teamA: number, teamB: number, kickoff = 'unknown', finished = false) {
  const a = Math.min(teamA, teamB);
  const b = Math.max(teamA, teamB);
  return { teamA: a, teamB: b, matchKey: `${a}-${b}-${kickoff}`, finished };
}

function fixturesByTeam(entries: Record<number, LiveFixtureData[]>): LiveFixturesByTeam {
  const result: Record<string, LiveFixturesByTeam[string]> = {};
  for (const [teamId, fixtures] of Object.entries(entries)) {
    const playing = fixtures.filter((f) => !f.finished);
    const finished = fixtures.filter((f) => f.finished);
    result[teamId] = { Playing: playing, Not_Start: [], Finished: finished };
  }
  return result;
}

describe('buildPlayingMatches', () => {
  it('pairs both directions of a fixture into one match', () => {
    const matches = buildPlayingMatches(
      fixturesByTeam({
        1: [fixture(1, 2, '2026-01-01T12:00:00Z')],
        2: [fixture(2, 1, '2026-01-01T12:00:00Z')],
      }),
    );
    expect(matches).toEqual([match(1, 2, '2026-01-01T12:00:00Z', false)]);
  });

  it('marks finished fixtures so settled DGW matches can skip estimation', () => {
    const matches = buildPlayingMatches(
      fixturesByTeam({
        1: [fixture(1, 2, 't1', true), fixture(1, 3, 't2', false)],
        2: [fixture(2, 1, 't1', true)],
        3: [fixture(3, 1, 't2', false)],
      }),
    );
    expect(matches.find((m) => m.matchKey === '1-2-t1')?.finished).toBe(true);
    expect(matches.find((m) => m.matchKey === '1-3-t2')?.finished).toBe(false);
  });

  it('maps every fixture of a double-gameweek team, not just the first', () => {
    const matches = buildPlayingMatches(
      fixturesByTeam({
        1: [fixture(1, 2, 't1'), fixture(1, 3, 't2')],
        2: [fixture(2, 1, 't1')],
        3: [fixture(3, 1, 't2')],
        4: [fixture(4, 5, 't3')],
        5: [fixture(5, 4, 't3')],
      }),
    );
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.matchKey).sort()).toEqual(['1-2-t1', '1-3-t2', '4-5-t3']);
  });

  it('keeps two fixtures between the same clubs as separate matches', () => {
    const matches = buildPlayingMatches(
      fixturesByTeam({
        1: [fixture(1, 2, 'sat'), fixture(1, 2, 'tue')],
        2: [fixture(2, 1, 'sat'), fixture(2, 1, 'tue')],
      }),
    );
    expect(matches).toHaveLength(2);
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
      [match(1, 2)],
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
      [match(1, 2)],
      [{ ...live(11, 1, 40), minutes: 0 }, live(21, 2, 20)],
    );
    expect(byTeam.get(1)).toBeUndefined();
    expect(byTeam.get(2)).toEqual(new Map([[21, 3]]));
  });

  it('uses FPL-assigned bonus values when a match is already settled', () => {
    const byTeam = computeLiveBonusByTeam(
      [match(1, 2)],
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
      fixturesByTeam({
        1: [fixture(1, 2, 't1'), fixture(1, 3, 't2')],
        2: [fixture(2, 1, 't1')],
        3: [fixture(3, 1, 't2')],
      }),
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

  it('seeds official DGW bonus and still estimates later fixture from remaining players', () => {
    // Team 1 plays 2 (finished) and 3 (live). Official bonus on 11 from fixture 1
    // is preserved; finished 1v2 is not re-estimated; live 1v3 estimates among
    // players without official bonus.
    const matches = [match(1, 2, 't1', true), match(1, 3, 't2', false)];
    const byTeam = computeLiveBonusByTeam(matches, [
      live(11, 1, 40, 3), // official bonus — seeded, excluded from 1v3 BPS pool
      live(12, 1, 10, 0),
      live(21, 2, 35, 2),
      live(22, 2, 5, 1),
      live(31, 3, 50, 0), // top among non-official for 1v3
      live(32, 3, 15, 0),
    ]);

    expect(byTeam.get(1)?.get(11)).toBe(3); // official preserved
    expect(byTeam.get(3)?.get(31)).toBe(3); // provisional for later fixture
  });

  it('does not re-estimate a finished DGW fixture over official zeros', () => {
    // 1v2 finished with official 3/2/1; 1v3 still live. Players on team 2 with
    // official 0 must not pick up provisional bonus from re-ranking 1v2.
    const matches = [match(1, 2, 't1', true), match(1, 3, 't2', false)];
    const byTeam = computeLiveBonusByTeam(matches, [
      live(11, 1, 40, 3),
      live(12, 1, 25, 0), // high BPS but official 0 in finished fixture
      live(21, 2, 35, 2),
      live(22, 2, 30, 0), // would get provisional 3 if 1v2 were re-estimated
      live(23, 2, 20, 1),
      live(31, 3, 50, 0),
      live(32, 3, 15, 0),
    ]);

    expect(byTeam.get(1)?.get(11)).toBe(3);
    expect(byTeam.get(2)?.get(21)).toBe(2);
    expect(byTeam.get(2)?.get(23)).toBe(1);
    // Team 2 only played the finished fixture — official zeros stay out
    expect(byTeam.get(2)?.get(22)).toBeUndefined();
    // Live fixture still estimates among non-official players
    expect(byTeam.get(3)?.get(31)).toBe(3);
  });

  it('still estimates a finished DGW fixture until official bonus appears', () => {
    // Post-whistle provisional window: fixture is Finished but FPL has not
    // posted bonus yet. Must still emit provisional 3/2/1 (unlike settled+official).
    const matches = [match(1, 2, 't1', true), match(1, 3, 't2', false)];
    const byTeam = computeLiveBonusByTeam(matches, [
      live(11, 1, 40, 0),
      live(12, 1, 25, 0),
      live(21, 2, 30, 0),
      live(22, 2, 10, 0),
      live(31, 3, 50, 0),
      live(32, 3, 15, 0),
    ]);

    // Finished 1v2: 11=3, 21=2, 12=1 from BPS
    expect(byTeam.get(1)?.get(11)).toBe(3);
    expect(byTeam.get(2)?.get(21)).toBe(2);
    expect(byTeam.get(1)?.get(12)).toBe(1);
    // Live 1v3 still estimated
    expect(byTeam.get(3)?.get(31)).toBe(3);
  });

  it('does not treat prior DGW official bonus as settled for a later fixture', () => {
    // Team 1 finished vs 2 with official bonus, then finishes vs 3 before FPL
    // posts match-2 bonus. Prior event-level bonus on team 1 must not skip
    // provisional 3/2/1 for 1v3 (single-match team 3 has no official yet).
    const matches = [match(1, 2, 't1', true), match(1, 3, 't2', true)];
    const byTeam = computeLiveBonusByTeam(matches, [
      live(11, 1, 40, 3), // official from 1v2 only
      live(12, 1, 10, 0),
      live(21, 2, 35, 2),
      live(22, 2, 5, 1),
      live(31, 3, 50, 0), // needs provisional for finished 1v3
      live(32, 3, 20, 0),
    ]);

    expect(byTeam.get(1)?.get(11)).toBe(3); // seed preserved
    expect(byTeam.get(2)?.get(21)).toBe(2);
    // 1v3 still estimates among non-official players
    expect(byTeam.get(3)?.get(31)).toBe(3);
    expect(byTeam.get(3)?.get(32)).toBe(2);
  });
});
