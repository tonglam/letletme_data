import type { TeamId } from '../types/base.type';

import type { Fixture, Team } from '../types';
import type {
  LiveFixtureByStatus,
  LiveFixtureData,
  LiveFixturesByTeam,
  MatchPlayStatus,
} from '../domain/live-fixtures';

function getPlayStatus(started: boolean, finished: boolean): MatchPlayStatus {
  if (finished) return 'Finished';
  if (!started) return 'Not_Start';
  return 'Playing';
}

function initTeamBucket(): LiveFixtureByStatus {
  return { Playing: [], Not_Start: [], Finished: [] };
}

export interface LiveFixtureTeamMaps {
  nameById: Map<number, string>;
  shortNameById: Map<number, string>;
  positionById: Map<number, number>;
}

export function createLiveFixtureTeamMaps(teams: readonly Team[]): LiveFixtureTeamMaps {
  const nameById = new Map<number, string>();
  const shortNameById = new Map<number, string>();
  const positionById = new Map<number, number>();

  for (const team of teams) {
    nameById.set(team.id, team.name);
    shortNameById.set(team.id, team.shortName);
    positionById.set(team.id, team.position ?? 0);
  }

  return { nameById, shortNameById, positionById };
}

function toLiveFixture(
  fixture: Fixture,
  teamId: TeamId,
  againstId: TeamId,
  isHome: boolean,
  teamScore: number | null,
  againstScore: number | null,
  nameById: Map<number, string>,
  shortNameById: Map<number, string>,
  positionById: Map<number, number>,
): LiveFixtureData {
  const kickoffTime = fixture.kickoffTime ? fixture.kickoffTime.toISOString() : null;
  const started = fixture.started ?? false;
  const finished = Boolean(fixture.finishedProvisional || fixture.finished);
  const safeTeamScore = teamScore ?? 0;
  const safeAgainstScore = againstScore ?? 0;

  return {
    fixtureId: fixture.id,
    teamId,
    teamName: nameById.get(teamId) ?? '',
    teamShortName: shortNameById.get(teamId) ?? '',
    teamScore: safeTeamScore,
    teamPosition: positionById.get(teamId) ?? 0,
    againstId,
    againstName: nameById.get(againstId) ?? '',
    againstShortName: shortNameById.get(againstId) ?? '',
    againstTeamScore: safeAgainstScore,
    againstTeamPosition: positionById.get(againstId) ?? 0,
    kickoffTime,
    score: `${safeTeamScore}-${safeAgainstScore}`,
    wasHome: isHome,
    started,
    finished,
  };
}

export function buildLiveFixturesByTeam(
  fixtures: Fixture[],
  maps: LiveFixtureTeamMaps,
): LiveFixturesByTeam {
  const byTeam = new Map<number, LiveFixtureByStatus>();
  const { nameById, shortNameById, positionById } = maps;

  for (const fixture of [...fixtures].sort((a, b) => a.id - b.id)) {
    const started = fixture.started ?? false;
    const finished = Boolean(fixture.finishedProvisional || fixture.finished);
    const status = getPlayStatus(started, finished);

    const homeId = fixture.teamH as TeamId;
    const awayId = fixture.teamA as TeamId;

    const homeFixture = toLiveFixture(
      fixture,
      homeId,
      awayId,
      true,
      fixture.teamHScore,
      fixture.teamAScore,
      nameById,
      shortNameById,
      positionById,
    );
    const homeBucket = byTeam.get(homeId) ?? initTeamBucket();
    homeBucket[status].push(homeFixture);
    byTeam.set(homeId, homeBucket);

    const awayFixture = toLiveFixture(
      fixture,
      awayId,
      homeId,
      false,
      fixture.teamAScore,
      fixture.teamHScore,
      nameById,
      shortNameById,
      positionById,
    );
    const awayBucket = byTeam.get(awayId) ?? initTeamBucket();
    awayBucket[status].push(awayFixture);
    byTeam.set(awayId, awayBucket);
  }

  const result: Record<string, LiveFixtureByStatus> = {};
  for (const [teamId, bucket] of byTeam.entries()) {
    result[String(teamId)] = bucket;
  }
  return result;
}
