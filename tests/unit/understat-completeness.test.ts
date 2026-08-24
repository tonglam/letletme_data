import { describe, expect, test } from 'bun:test';

import { UNDERSTAT_SPLIT_DIMENSIONS } from '../../src/domain/understat';
import {
  assertUnderstatResourceHashes,
  evaluateUnderstatPlayerMatchResourceCompleteness,
  evaluateUnderstatPlayerTeamResourceCompleteness,
  evaluateUnderstatPlayerSnapshotCompleteness,
  evaluateUnderstatTeamResourceCompleteness,
  evaluateUnderstatTeamSnapshotCompleteness,
} from '../../src/services/understat-sync.service';

const teams = Array.from({ length: 20 }, (_, index) => ({ team: { id: index + 1 } }));
const matches = Array.from({ length: 380 }, (_, index) => ({
  id: index + 1,
  homeTeamId: (index % 20) + 1,
  awayTeamId: ((index + 1) % 20) + 1,
  isResult: index === 0,
}));
const splits = teams.flatMap(({ team }) =>
  UNDERSTAT_SPLIT_DIMENSIONS.map((dimension) => ({ teamId: team.id, dimension })),
);
const completeTeamMatchRows = [
  { match: { id: 1 }, stat: { teamId: 1, side: 'h' } },
  { match: { id: 1 }, stat: { teamId: 2, side: 'a' } },
];

describe('Understat PostgreSQL snapshot completeness guards', () => {
  test('rejects a scoped write that did not survive post-commit verification', () => {
    expect(() => assertUnderstatResourceHashes('team splits', ['a', 'b'], ['a'])).toThrow(
      'expected=2 persisted=1',
    );
    expect(() =>
      assertUnderstatResourceHashes('team splits', ['b', 'a'], ['a', 'b']),
    ).not.toThrow();
  });

  test('does not publish a one-team smoke snapshot', () => {
    const result = evaluateUnderstatTeamSnapshotCompleteness('EPL', {
      teams,
      matches,
      teamMatchRows: completeTeamMatchRows,
      splits: splits.filter((row) => row.teamId === 1),
    });

    expect(result.complete).toBe(false);
    expect(result.reason).toContain('team 2 split dimensions missing');
  });

  test('requires both team-stat sides for every completed match', () => {
    const result = evaluateUnderstatTeamSnapshotCompleteness('EPL', {
      teams,
      matches,
      teamMatchRows: completeTeamMatchRows.slice(0, 1),
      splits,
    });

    expect(result.complete).toBe(false);
    expect(result.reason).toContain('completed match 1');
  });

  test('accepts a globally complete team snapshot', () => {
    expect(
      evaluateUnderstatTeamSnapshotCompleteness('EPL', {
        teams,
        matches,
        teamMatchRows: completeTeamMatchRows,
        splits,
      }),
    ).toEqual({ complete: true, reason: 'complete' });
  });

  test('accepts one complete team while another team is still unavailable', () => {
    expect(
      evaluateUnderstatTeamResourceCompleteness(
        1,
        {
          teams: teams.map(({ team }) => team),
          teamSeasons: teams.map(({ team }) => ({ teamId: team.id })),
          matches,
          teamMatchStats: completeTeamMatchRows.map(({ match, stat }) => ({
            matchId: match.id,
            teamId: stat.teamId,
            side: stat.side as 'h' | 'a',
          })),
        },
        splits.filter((row) => row.teamId === 1),
      ),
    ).toEqual({ complete: true, reason: 'complete' });
    expect(
      evaluateUnderstatTeamResourceCompleteness(
        2,
        {
          teams: teams.map(({ team }) => team),
          teamSeasons: teams.map(({ team }) => ({ teamId: team.id })),
          matches,
          teamMatchStats: completeTeamMatchRows.map(({ match, stat }) => ({
            matchId: match.id,
            teamId: stat.teamId,
            side: stat.side as 'h' | 'a',
          })),
        },
        [],
      ),
    ).toMatchObject({ complete: false });
  });

  test('requires participants for all teams and two eleven-player starting sides', () => {
    const players = Array.from({ length: 20 }, (_, index) => ({ player: { id: index + 101 } }));
    const memberships = players.map(({ player }, index) => ({
      playerId: player.id,
      teamId: index + 1,
    }));
    const home = Array.from({ length: 11 }, () => ({
      match: { id: 1 },
      stat: { teamId: 1, side: 'h', started: true },
    }));
    const away = Array.from({ length: 11 }, () => ({
      match: { id: 1 },
      stat: { teamId: 2, side: 'a', started: true },
    }));

    expect(
      evaluateUnderstatPlayerSnapshotCompleteness('EPL', matches, {
        players,
        memberships,
        matchStats: [...home, ...away.slice(0, 10)],
      }),
    ).toMatchObject({ complete: false });
    expect(
      evaluateUnderstatPlayerSnapshotCompleteness('EPL', matches, {
        players,
        memberships,
        matchStats: [...home, ...away],
      }),
    ).toEqual({ complete: true, reason: 'complete' });
  });

  test('evaluates player participants and rosters independently', () => {
    expect(
      evaluateUnderstatPlayerTeamResourceCompleteness(1, { playerSeasons: [{ playerId: 101 }] }, [
        { playerId: 101 },
      ]),
    ).toEqual({ complete: true, reason: 'complete' });
    expect(
      evaluateUnderstatPlayerTeamResourceCompleteness(
        2,
        { playerSeasons: [{ playerId: 101 }] },
        [],
      ),
    ).toMatchObject({ complete: false });

    const roster = [
      ...Array.from({ length: 11 }, () => ({
        matchId: 1,
        teamId: 1,
        side: 'h' as const,
        started: true,
      })),
      ...Array.from({ length: 11 }, () => ({
        matchId: 1,
        teamId: 2,
        side: 'a' as const,
        started: true,
      })),
    ];
    expect(
      evaluateUnderstatPlayerMatchResourceCompleteness(
        { id: 1, homeTeamId: 1, awayTeamId: 2 },
        roster,
      ),
    ).toEqual({ complete: true, reason: 'complete' });
  });
});
