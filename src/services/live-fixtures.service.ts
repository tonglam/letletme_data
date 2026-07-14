import { liveFixturesCache } from '../cache/operations';
import { getDb } from '../db/singleton';
import { teams } from '../db/schemas/index.schema';
import type { EventId, TeamId } from '../types/base.type';
import { fixtureRepository } from '../repositories/fixtures';
import { logError, logInfo } from '../utils/logger';
import { getCurrentEvent } from './events.service';

import type { Fixture } from '../types';
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

async function loadTeamMaps(): Promise<{
  nameById: Map<number, string>;
  shortNameById: Map<number, string>;
  positionById: Map<number, number>;
}> {
  const db = await getDb();
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      shortName: teams.shortName,
      position: teams.position,
    })
    .from(teams);

  const nameById = new Map<number, string>();
  const shortNameById = new Map<number, string>();
  const positionById = new Map<number, number>();

  for (const row of rows) {
    nameById.set(row.id, row.name);
    shortNameById.set(row.id, row.shortName);
    positionById.set(row.id, row.position ?? 0);
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

function buildLiveFixturesByTeam(
  fixtures: Fixture[],
  nameById: Map<number, string>,
  shortNameById: Map<number, string>,
  positionById: Map<number, number>,
): LiveFixturesByTeam {
  const byTeam = new Map<number, LiveFixtureByStatus>();

  for (const fixture of fixtures) {
    const started = fixture.started ?? false;
    const finished = Boolean(fixture.finishedProvisional || fixture.finished);
    const status = getPlayStatus(started, finished);

    const homeId = fixture.teamH as TeamId;
    const awayId = fixture.teamA as TeamId;

    const homeBucket = byTeam.get(homeId) ?? initTeamBucket();
    homeBucket[status].push(
      toLiveFixture(
        fixture,
        homeId,
        awayId,
        true,
        fixture.teamHScore,
        fixture.teamAScore,
        nameById,
        shortNameById,
        positionById,
      ),
    );
    byTeam.set(homeId, homeBucket);

    const awayBucket = byTeam.get(awayId) ?? initTeamBucket();
    awayBucket[status].push(
      toLiveFixture(
        fixture,
        awayId,
        homeId,
        false,
        fixture.teamAScore,
        fixture.teamHScore,
        nameById,
        shortNameById,
        positionById,
      ),
    );
    byTeam.set(awayId, awayBucket);
  }

  const out: Record<string, LiveFixtureByStatus> = {};
  for (const [teamId, bucket] of byTeam.entries()) {
    out[String(teamId)] = bucket;
  }
  return out;
}

/**
 * LiveFixture: cache-only sync for current event fixtures, grouped per team and play status.
 *
 * Data source: `event_fixtures` table (already synced elsewhere).
 * Cache: `LiveFixture:{season}:{eventId}` (hash teamId -> LiveFixtureByStatus JSON), delete-first, TTL -1.
 */
export async function syncLiveFixtureCache(
  eventId?: EventId,
): Promise<{ eventId: EventId; teamCount: number }> {
  try {
    const resolvedEventId = eventId ?? (await getCurrentEvent())?.id;
    if (!resolvedEventId) {
      throw new Error('No current event found for live fixture cache');
    }

    logInfo('Starting live fixture cache sync', { eventId: resolvedEventId });

    const fixtures = await fixtureRepository.findByEvent(resolvedEventId);
    const { nameById, shortNameById, positionById } = await loadTeamMaps();
    const byTeam = buildLiveFixturesByTeam(fixtures, nameById, shortNameById, positionById);

    await liveFixturesCache.set(resolvedEventId, byTeam);

    const teamCount = Object.keys(byTeam).length;
    logInfo('Live fixture cache sync completed', { eventId: resolvedEventId, teamCount });
    return { eventId: resolvedEventId, teamCount };
  } catch (error) {
    logError('Live fixture cache sync failed', error, { eventId });
    throw error;
  }
}
