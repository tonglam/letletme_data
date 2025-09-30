import { Fixture, RawFPLFixture } from '../types';

// Transform FPL API fixture to our domain Fixture
export function transformFixture(rawFixture: RawFPLFixture): Fixture {
  return {
    id: rawFixture.id,
    code: rawFixture.code,
    event: rawFixture.event,
    finished: rawFixture.finished,
    finishedProvisional: rawFixture.finished_provisional,
    kickoffTime: rawFixture.kickoff_time ? new Date(rawFixture.kickoff_time) : null,
    minutes: rawFixture.minutes,
    provisionalStartTime: rawFixture.provisional_start_time,
    started: rawFixture.started,
    teamA: rawFixture.team_a,
    teamAScore: rawFixture.team_a_score,
    teamH: rawFixture.team_h,
    teamHScore: rawFixture.team_h_score,
    stats: rawFixture.stats,
    teamHDifficulty: rawFixture.team_h_difficulty,
    teamADifficulty: rawFixture.team_a_difficulty,
    pulseId: rawFixture.pulse_id,
    createdAt: null,
    updatedAt: null,
  };
}

// Transform array of fixtures
export function transformFixtures(rawFixtures: RawFPLFixture[]): Fixture[] {
  return rawFixtures.map(transformFixture);
}
