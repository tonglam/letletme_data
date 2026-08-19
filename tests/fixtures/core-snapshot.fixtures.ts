import { singleRawEventFixture } from './events.fixtures';
import { rawFPLElementsFixture } from './player-stats.fixtures';
import { singleRawTeamFixture } from './teams.fixtures';

import type {
  FPLBootstrapResponse,
  RawFPLEvent,
  RawFPLFixture,
  RawFPLPhase,
  RawFPLTeam,
} from '../../src/types';

function buildEvents(): RawFPLEvent[] {
  const firstDeadline = Date.parse('2026-08-14T17:30:00.000Z');
  return Array.from({ length: 38 }, (_, index) => {
    const deadline = new Date(firstDeadline + index * 7 * 24 * 60 * 60_000);
    return {
      ...singleRawEventFixture,
      id: index + 1,
      name: `Gameweek ${index + 1}`,
      deadline_time: deadline.toISOString(),
      deadline_time_epoch: Math.floor(deadline.getTime() / 1000),
      is_previous: false,
      is_current: false,
      is_next: index === 0,
      finished: false,
      data_checked: false,
    };
  });
}

function buildTeams(): RawFPLTeam[] {
  return Array.from({ length: 20 }, (_, index) => ({
    ...singleRawTeamFixture,
    id: index + 1,
    code: 10_000 + index,
    name: `Team ${index + 1}`,
    short_name: `T${String(index + 1).padStart(2, '0')}`,
    position: index + 1,
    pulse_id: 20_000 + index,
  }));
}

function firstHalfPairings(): Array<Array<[number, number]>> {
  const rotating = Array.from({ length: 20 }, (_, index) => index + 1);
  const rounds: Array<Array<[number, number]>> = [];

  for (let round = 0; round < 19; round += 1) {
    const pairings: Array<[number, number]> = [];
    for (let index = 0; index < 10; index += 1) {
      pairings.push([rotating[index], rotating[19 - index]]);
    }
    rounds.push(pairings);
    rotating.splice(1, 0, rotating.pop()!);
  }
  return rounds;
}

function buildFixtures(): RawFPLFixture[] {
  const firstHalf = firstHalfPairings();
  const rounds = [
    ...firstHalf,
    ...firstHalf.map((round) => round.map(([home, away]) => [away, home] as [number, number])),
  ];
  let fixtureId = 1;

  return rounds.flatMap((round, roundIndex) =>
    round.map(([teamH, teamA]) => {
      const id = fixtureId;
      fixtureId += 1;
      return {
        code: 30_000 + id,
        event: roundIndex + 1,
        finished: false,
        finished_provisional: false,
        id,
        kickoff_time: new Date(
          Date.parse('2026-08-15T14:00:00.000Z') + roundIndex * 7 * 24 * 60 * 60_000,
        ).toISOString(),
        minutes: 0,
        provisional_start_time: false,
        started: false,
        team_a: teamA,
        team_a_score: null,
        team_h: teamH,
        team_h_score: null,
        stats: [],
        team_h_difficulty: 3,
        team_a_difficulty: 3,
        pulse_id: 40_000 + id,
      };
    }),
  );
}

export function buildCoreSnapshotFixture(options?: { playerCount?: number }): {
  bootstrap: FPLBootstrapResponse;
  fixtures: RawFPLFixture[];
} {
  const playerCount = options?.playerCount ?? 220;
  const players = Array.from({ length: playerCount }, (_, index) => {
    const base = rawFPLElementsFixture[index % rawFPLElementsFixture.length];
    return {
      ...base,
      id: index + 1,
      code: 50_000 + index,
      element_type: (index % 4) + 1,
      team: (index % 20) + 1,
      web_name: `Player ${index + 1}`,
    };
  });
  const phases: RawFPLPhase[] = [
    { id: 1, name: 'Overall', start_event: 1, stop_event: 38, highest_score: null },
  ];

  return {
    bootstrap: {
      events: buildEvents(),
      teams: buildTeams(),
      elements: players,
      phases,
      total_players: 1,
      game_settings: {},
      element_stats: [],
      element_types: [],
      chips: [],
    },
    fixtures: buildFixtures(),
  };
}
