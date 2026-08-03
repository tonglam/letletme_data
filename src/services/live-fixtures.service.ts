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
  LiveFixtureByStatusV2,
  LiveFixtureData,
  LiveFixtureDataV2,
  LiveFixturesByTeam,
  LiveFixturesV2ByTeam,
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

function initTeamBucketV2(): LiveFixtureByStatusV2 {
  return { Playing: [], Not_Start: [], Finished: [] };
}

export interface LiveFixtureTeamMaps {
  nameById: Map<number, string>;
  shortNameById: Map<number, string>;
  positionById: Map<number, number>;
}

export interface LiveFixtureViews {
  legacy: LiveFixturesByTeam;
  v2: LiveFixturesV2ByTeam;
}

export async function loadLiveFixtureTeamMaps(): Promise<LiveFixtureTeamMaps> {
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

function toLiveFixtureViews(
  fixture: Fixture,
  teamId: TeamId,
  againstId: TeamId,
  isHome: boolean,
  teamScore: number | null,
  againstScore: number | null,
  nameById: Map<number, string>,
  shortNameById: Map<number, string>,
  positionById: Map<number, number>,
): { legacy: LiveFixtureData; v2: LiveFixtureDataV2 } {
  const kickoffTime = fixture.kickoffTime ? fixture.kickoffTime.toISOString() : null;
  const started = fixture.started ?? false;
  const finished = Boolean(fixture.finishedProvisional || fixture.finished);
  const safeTeamScore = teamScore ?? 0;
  const safeAgainstScore = againstScore ?? 0;

  const legacy: LiveFixtureData = {
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

  return {
    legacy,
    v2: { fixtureId: fixture.id, ...legacy },
  };
}

export function buildLiveFixtureViews(
  fixtures: Fixture[],
  maps: LiveFixtureTeamMaps,
): LiveFixtureViews {
  const legacyByTeam = new Map<number, LiveFixtureByStatus>();
  const v2ByTeam = new Map<number, LiveFixtureByStatusV2>();
  const { nameById, shortNameById, positionById } = maps;

  for (const fixture of [...fixtures].sort((a, b) => a.id - b.id)) {
    const started = fixture.started ?? false;
    const finished = Boolean(fixture.finishedProvisional || fixture.finished);
    const status = getPlayStatus(started, finished);

    const homeId = fixture.teamH as TeamId;
    const awayId = fixture.teamA as TeamId;

    const homeFixture = toLiveFixtureViews(
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
    const homeLegacyBucket = legacyByTeam.get(homeId) ?? initTeamBucket();
    homeLegacyBucket[status].push(homeFixture.legacy);
    legacyByTeam.set(homeId, homeLegacyBucket);
    const homeV2Bucket = v2ByTeam.get(homeId) ?? initTeamBucketV2();
    homeV2Bucket[status].push(homeFixture.v2);
    v2ByTeam.set(homeId, homeV2Bucket);

    const awayFixture = toLiveFixtureViews(
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
    const awayLegacyBucket = legacyByTeam.get(awayId) ?? initTeamBucket();
    awayLegacyBucket[status].push(awayFixture.legacy);
    legacyByTeam.set(awayId, awayLegacyBucket);
    const awayV2Bucket = v2ByTeam.get(awayId) ?? initTeamBucketV2();
    awayV2Bucket[status].push(awayFixture.v2);
    v2ByTeam.set(awayId, awayV2Bucket);
  }

  const legacy: Record<string, LiveFixtureByStatus> = {};
  for (const [teamId, bucket] of legacyByTeam.entries()) {
    legacy[String(teamId)] = bucket;
  }
  const v2: Record<string, LiveFixtureByStatusV2> = {};
  for (const [teamId, bucket] of v2ByTeam.entries()) {
    v2[String(teamId)] = bucket;
  }

  return { legacy, v2 };
}

export function buildLiveFixturesByTeam(
  fixtures: Fixture[],
  maps: LiveFixtureTeamMaps,
): LiveFixturesByTeam {
  return buildLiveFixtureViews(fixtures, maps).legacy;
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
    const maps = await loadLiveFixtureTeamMaps();
    const byTeam = buildLiveFixturesByTeam(fixtures, maps);

    await liveFixturesCache.set(resolvedEventId, byTeam);

    const teamCount = Object.keys(byTeam).length;
    logInfo('Live fixture cache sync completed', { eventId: resolvedEventId, teamCount });
    return { eventId: resolvedEventId, teamCount };
  } catch (error) {
    logError('Live fixture cache sync failed', error, { eventId });
    throw error;
  }
}
