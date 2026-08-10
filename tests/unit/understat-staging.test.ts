import { describe, expect, test } from 'bun:test';

import type {
  UnderstatMatch,
  UnderstatPlayer,
  UnderstatPlayerDiscovery,
  UnderstatPlayerMatchStat,
  UnderstatPlayerTeamSeason,
  UnderstatTeamDiscovery,
  UnderstatTeamStatSplit,
} from '../../src/domain/understat';
import {
  readStagedUnderstatPlayerLeague,
  readStagedUnderstatPlayerMatchDetail,
  readStagedUnderstatPlayerTeamDetail,
  readStagedUnderstatTeamDetail,
  readStagedUnderstatTeamLeague,
  stageUnderstatPlayerLeague,
  stageUnderstatPlayerMatchDetail,
  stageUnderstatPlayerTeamDetail,
  stageUnderstatTeamDetail,
  stageUnderstatTeamLeague,
  understatStagingHash,
} from '../../src/services/understat-staging';

const season = '2526';
const capturedAt = new Date('2025-08-17T15:30:00.000Z');
const team = {
  id: 83,
  title: 'Arsenal',
  shortTitle: 'ARS',
  firstSeenSeason: season,
  lastSeenSeason: season,
  sourceHash: 'team-hash',
};
const match: UnderstatMatch = {
  id: 28_786,
  season,
  homeTeamId: 89,
  awayTeamId: 83,
  kickoffAt: capturedAt,
  isResult: true,
  homeGoals: 0,
  awayGoals: 1,
  homeXg: 1.37,
  awayXg: 1.33,
  forecastHomeWin: 0.38,
  forecastDraw: 0.26,
  forecastAwayWin: 0.36,
  sourceHash: 'match-hash',
  sourceCheckedAt: capturedAt,
  lastSeenAt: capturedAt,
};
const player: UnderstatPlayer = {
  id: 1_001,
  name: 'Example Player',
  favoritePosition: 'FW',
  firstSeenSeason: season,
  lastSeenSeason: season,
  sourceHash: 'player-hash',
};
const playerStats = {
  games: 1,
  time: 90,
  goals: 1,
  npg: 1,
  assists: 0,
  shots: 2,
  keyPasses: 1,
  yellowCards: 0,
  redCards: 0,
  xg: 0.75,
  npxg: 0.75,
  xa: 0.12,
  xgChain: 0.9,
  xgBuildup: 0.15,
  position: 'FW',
};

function teamDiscovery(): UnderstatTeamDiscovery {
  return {
    season: {
      season,
      sourceYear: 2025,
      league: 'EPL',
      state: 'complete',
      firstSeenAt: capturedAt,
      lastSeenAt: capturedAt,
    },
    teams: [team],
    matches: [match],
    teamMatchStats: [],
    teamSeasons: [
      {
        season,
        teamId: team.id,
        sourceTitle: team.title,
        sourceShortTitle: team.shortTitle,
        games: 1,
        wins: 1,
        draws: 0,
        losses: 0,
        goalsFor: 1,
        goalsAgainst: 0,
        points: 3,
        xg: 1.33,
        xga: 1.37,
        npxg: 1.33,
        npxga: 1.37,
        npxgd: -0.04,
        xpoints: 1.8,
        deep: 6,
        deepAllowed: 5,
        ppdaAtt: 292,
        ppdaDef: 18,
        ppdaAllowedAtt: 250,
        ppdaAllowedDef: 28,
        sourceHash: 'team-season-hash',
        lastSyncedAt: capturedAt,
      },
    ],
  };
}

function playerDiscovery(): UnderstatPlayerDiscovery {
  return {
    season: teamDiscovery().season,
    teams: [team],
    matches: [match],
    players: [player],
    playerSeasons: [
      {
        season,
        playerId: player.id,
        sourceName: player.name,
        sourceTeamTitle: team.title,
        ...playerStats,
        sourceHash: 'player-season-hash',
      },
    ],
  };
}

const split: UnderstatTeamStatSplit = {
  season,
  teamId: team.id,
  dimension: 'result',
  splitKey: 'goal',
  label: 'Goal',
  timeMinutes: null,
  shotsFor: 2,
  goalsFor: 1,
  xgFor: 0.75,
  shotsAgainst: 1,
  goalsAgainst: 0,
  xgAgainst: 0.1,
  sourceHash: 'split-hash',
};
const membership: UnderstatPlayerTeamSeason = {
  season,
  playerId: player.id,
  teamId: team.id,
  ...playerStats,
  sourceHash: 'membership-hash',
};
const matchStat: UnderstatPlayerMatchStat = {
  rosterId: 7_101,
  matchId: match.id,
  playerId: player.id,
  teamId: team.id,
  playerName: player.name,
  side: 'a',
  position: 'FW',
  positionOrder: 15,
  minutes: 70,
  started: false,
  goals: 1,
  ownGoals: 0,
  shots: 2,
  keyPasses: 1,
  assists: 0,
  yellowCards: 0,
  redCards: 0,
  xg: 0.75,
  xa: 0.12,
  xgChain: 0.9,
  xgBuildup: 0.15,
  rosterInId: 7_102,
  rosterOutId: null,
  sourceHash: 'match-stat-hash',
};

describe('Understat PostgreSQL staging envelopes', () => {
  test('round-trips every normalized resource and rehydrates timestamps', () => {
    const teamLeague = stageUnderstatTeamLeague(season, teamDiscovery());
    const teamDetail = stageUnderstatTeamDetail(season, team.id, [split]);
    const playerLeague = stageUnderstatPlayerLeague(season, playerDiscovery());
    const playerTeam = stageUnderstatPlayerTeamDetail(season, team.id, [player], [membership]);
    const playerMatch = stageUnderstatPlayerMatchDetail(season, match.id, [player], [matchStat]);

    const teamLeagueResult = readStagedUnderstatTeamLeague(
      teamLeague,
      understatStagingHash(teamLeague),
      season,
    );
    const playerLeagueResult = readStagedUnderstatPlayerLeague(
      playerLeague,
      understatStagingHash(playerLeague),
      season,
    );
    expect(teamLeagueResult.matches[0]?.kickoffAt).toBeInstanceOf(Date);
    expect(teamLeagueResult.teamSeasons[0]?.lastSyncedAt).toBeInstanceOf(Date);
    expect(playerLeagueResult.season.firstSeenAt).toBeInstanceOf(Date);
    expect(
      readStagedUnderstatTeamDetail(teamDetail, understatStagingHash(teamDetail), season),
    ).toEqual({ teamId: team.id, rows: [split] });
    expect(
      readStagedUnderstatPlayerTeamDetail(playerTeam, understatStagingHash(playerTeam), season),
    ).toEqual({ teamId: team.id, players: [player], rows: [membership] });
    expect(
      readStagedUnderstatPlayerMatchDetail(playerMatch, understatStagingHash(playerMatch), season),
    ).toEqual({ matchId: match.id, players: [player], rows: [matchStat] });
  });

  test('rejects tampering and an unexpected season before persistence', () => {
    const staged = stageUnderstatTeamLeague(season, teamDiscovery());
    const originalHash = understatStagingHash(staged);
    const tampered = structuredClone(staged);
    const data = tampered.data as Record<string, unknown>;
    data.discovery = { ...(data.discovery as Record<string, unknown>), teams: [] };

    expect(() => readStagedUnderstatTeamLeague(tampered, originalHash, season)).toThrow(
      'payload hash mismatch',
    );
    expect(() => readStagedUnderstatTeamLeague(staged, originalHash, '2627')).toThrow(
      'Unexpected Understat staging envelope',
    );
  });

  test('rejects extra envelope fields even when the content hash is valid', () => {
    const staged = stageUnderstatTeamLeague(season, teamDiscovery());
    const withExtraField = { ...staged, extraField: true };

    expect(() =>
      readStagedUnderstatTeamLeague(withExtraField, understatStagingHash(withExtraField), season),
    ).toThrow('Unexpected Understat staging envelope fields');
  });

  test('rejects resource identities that do not match the envelope key', () => {
    const mismatchedSplit = { ...split, teamId: team.id + 1 };
    const stagedTeam = stageUnderstatTeamDetail(season, team.id, [mismatchedSplit]);
    expect(() =>
      readStagedUnderstatTeamDetail(stagedTeam, understatStagingHash(stagedTeam), season),
    ).toThrow('identity mismatch');

    const mismatchedMatch = { ...matchStat, matchId: match.id + 1 };
    const stagedMatch = stageUnderstatPlayerMatchDetail(
      season,
      match.id,
      [player],
      [mismatchedMatch],
    );
    expect(() =>
      readStagedUnderstatPlayerMatchDetail(stagedMatch, understatStagingHash(stagedMatch), season),
    ).toThrow('identity mismatch');
  });
});
