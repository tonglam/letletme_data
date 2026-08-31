import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  createFplPlayerFixtureStatsRepository,
  type FplPlayerFixtureIdentity,
} from '../repositories/fpl-player-fixture-stats';
import { createPlayerRepository } from '../repositories/players';
import { createTeamRepository } from '../repositories/teams';
import type { Fixture, Player, RawFPLEventLiveResponse, RawFPLFixture, Team } from '../types';
import { transformFixtures } from '../transformers/fixtures';
import { DatabaseError } from '../utils/errors';
import { logWarn } from '../utils/logger';
import { prepareEventLives, type PreparedEventLives } from './event-lives.service';
import { createLiveFixtureTeamMaps, type LiveFixtureTeamMaps } from './live-fixtures.service';
import { withCoreSnapshotReadLock } from './core-snapshot-persistence.service';

export type LiveSnapshotState = 'scheduled' | 'live' | 'settled';

type LivePlayerIdentity = Pick<Player, 'id' | 'type' | 'teamId' | 'price' | 'webName'>;

export interface LiveSnapshotReferenceData extends LiveFixtureTeamMaps {
  readonly season: string;
  readonly playerTeamById: Map<number, number>;
  /**
   * Minimum player identity required by the fixture-grain Live Matches
   * detail publication.  It is optional for the existing Live Points
   * preparation path; Match V2 fails closed for detail when it is absent.
   */
  readonly playerById?: ReadonlyMap<number, LivePlayerIdentity>;
  /**
   * Event-time identity captured with fixture evidence. It is loaded for every
   * live event so a current-roster transfer cannot replace the club represented
   * by the fixture.
   */
  readonly playerByFixtureAndId?: ReadonlyMap<string, LivePlayerIdentity>;
}

export interface PreparedLiveSnapshot {
  readonly season: string;
  readonly eventId: number;
  readonly eventLives: PreparedEventLives;
  readonly fixtures: Fixture[];
  readonly state: LiveSnapshotState;
  readonly liveIdentityBaseline: 'current-roster' | 'published-event';
}

function buildCurrentSeasonPlayerTeamMap(
  players: readonly Pick<Player, 'id' | 'teamId'>[],
  season: string,
): Map<number, number> {
  const playerTeamById = new Map<number, number>();
  for (const player of players) {
    if (
      !Number.isInteger(player.id) ||
      player.id <= 0 ||
      !Number.isInteger(player.teamId) ||
      player.teamId <= 0
    ) {
      throw new Error(`Current-season player roster ${season} contains invalid identity`);
    }
    if (playerTeamById.has(player.id)) {
      throw new Error(`Current-season player roster ${season} contains duplicate player IDs`);
    }
    playerTeamById.set(player.id, player.teamId);
  }
  return playerTeamById;
}

function referenceDataFromCore(
  season: FplSeasonRef,
  teams: readonly Team[],
  players: readonly Player[],
): LiveSnapshotReferenceData {
  if (teams.length === 0 || players.length === 0) {
    throw new DatabaseError(
      `Core identity baseline is incomplete for season ${season.seasonCode}`,
      'LIVE_REFERENCE_DATA_INCOMPLETE',
    );
  }
  const playerById = new Map(
    players.map((player) => [
      player.id,
      {
        id: player.id,
        type: player.type,
        teamId: player.teamId,
        price: player.price,
        webName: player.webName,
      },
    ]),
  );
  return {
    season: season.seasonCode,
    ...createLiveFixtureTeamMaps(teams),
    playerTeamById: buildCurrentSeasonPlayerTeamMap(players, season.seasonCode),
    playerById,
  };
}

function addEventPinnedIdentities(
  referenceData: LiveSnapshotReferenceData,
  eventPinnedIdentities: readonly FplPlayerFixtureIdentity[],
): LiveSnapshotReferenceData {
  const playerByFixtureAndId = new Map<string, LivePlayerIdentity>();
  for (const identity of eventPinnedIdentities) {
    if (
      !Number.isSafeInteger(identity.fixtureId) ||
      identity.fixtureId <= 0 ||
      !Number.isSafeInteger(identity.elementId) ||
      identity.elementId <= 0 ||
      !Number.isSafeInteger(identity.teamId) ||
      identity.teamId <= 0 ||
      !Number.isSafeInteger(identity.elementType) ||
      identity.elementType < 1 ||
      identity.elementType > 4 ||
      !identity.webName.trim()
    ) {
      throw new DatabaseError(
        `Event-pinned player identity is invalid for event ${identity.fixtureId}`,
        'LIVE_EVENT_PLAYER_IDENTITY_INVALID',
      );
    }
    const key = `${identity.fixtureId}:${identity.elementId}`;
    if (playerByFixtureAndId.has(key)) {
      throw new DatabaseError(
        `Event-pinned player identity is duplicated for ${key}`,
        'LIVE_EVENT_PLAYER_IDENTITY_DUPLICATE',
      );
    }
    playerByFixtureAndId.set(key, {
      id: identity.elementId,
      type: identity.elementType,
      teamId: identity.teamId,
      price: identity.price,
      webName: identity.webName,
    });
  }

  return {
    ...referenceData,
    ...(playerByFixtureAndId.size > 0 ? { playerByFixtureAndId } : {}),
  };
}

async function loadEventPinnedIdentities(
  season: FplSeasonRef,
  eventId: number,
): Promise<readonly FplPlayerFixtureIdentity[] | null> {
  try {
    return await createFplPlayerFixtureStatsRepository().findIdentityByEvent(season, eventId);
  } catch (error) {
    // Event-time identity enriches the fixture-grain detail publication; it
    // must never take an already valid Core/live observation off the serving
    // path. Detail keeps its compatible LKG until this enrichment recovers,
    // while Live Points continues with the current-roster Core baseline.
    logWarn('Live event identity enrichment unavailable; continuing with Core reference data', {
      season: season.seasonCode,
      eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Core metadata for coherent validation; it is never a live publication. */
export async function loadLiveReferenceData(
  season: FplSeasonRef,
  eventId: number,
): Promise<LiveSnapshotReferenceData> {
  const cached = await readCoreSnapshotCache(season.seasonCode);
  const coreReferenceData = cached
    ? referenceDataFromCore(season, cached.teams, cached.players)
    : await withCoreSnapshotReadLock(season, async (transaction) => {
        const [teams, players] = await Promise.all([
          createTeamRepository(transaction).findAll(season),
          createPlayerRepository(transaction).findAll(season),
        ]);
        return referenceDataFromCore(season, teams, players);
      });

  const eventPinnedIdentities = await loadEventPinnedIdentities(season, eventId);
  if (eventPinnedIdentities === null || eventPinnedIdentities.length === 0) {
    return coreReferenceData;
  }
  try {
    return addEventPinnedIdentities(coreReferenceData, eventPinnedIdentities);
  } catch (error) {
    // A malformed/duplicate identity row is equivalent to an unavailable
    // enrichment for this observation. Never discard the valid Core baseline
    // or overwrite a previously published detail candidate because of it.
    logWarn('Live event identity enrichment is invalid; continuing with Core reference data', {
      season: season.seasonCode,
      eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    return coreReferenceData;
  }
}

function resolveSnapshotState(fixtures: readonly Fixture[]): LiveSnapshotState {
  if (fixtures.length === 0) return 'scheduled';
  if (
    fixtures.some(
      (fixture) => fixture.started === true && !fixture.finished && !fixture.finishedProvisional,
    )
  )
    return 'live';
  if (fixtures.every((fixture) => fixture.finished || fixture.finishedProvisional))
    return 'settled';
  return fixtures.some(
    (fixture) => fixture.started || fixture.finished || fixture.finishedProvisional,
  )
    ? 'live'
    : 'scheduled';
}

export function validateLiveElementIdentity(
  eventId: number,
  liveElementIds: readonly number[],
  referenceData: Pick<LiveSnapshotReferenceData, 'playerTeamById'>,
  publishedLiveElementIds: readonly number[] = [],
): 'current-roster' | 'published-event' {
  const expectedLiveElementIds = [...referenceData.playerTeamById.keys()];
  if (
    new Set(liveElementIds).size !== liveElementIds.length ||
    new Set(expectedLiveElementIds).size !== expectedLiveElementIds.length ||
    new Set(publishedLiveElementIds).size !== publishedLiveElementIds.length
  )
    throw new Error(`Duplicate player identity in live snapshot event ${eventId}`);
  const actualPlayerIds = new Set(liveElementIds);
  const expectedPlayerIds = new Set(expectedLiveElementIds);
  const publishedPlayerIds = new Set(publishedLiveElementIds);
  const missingPlayers = expectedLiveElementIds.filter((id) => !actualPlayerIds.has(id));
  const unexpectedPlayers = liveElementIds.filter((id) => !expectedPlayerIds.has(id));
  const matchesCurrentRoster = missingPlayers.length === 0 && unexpectedPlayers.length === 0;
  const matchesPublishedEvent =
    publishedLiveElementIds.length > 0 &&
    liveElementIds.length === publishedLiveElementIds.length &&
    liveElementIds.every((id) => publishedPlayerIds.has(id));
  if (!matchesCurrentRoster && !matchesPublishedEvent) {
    throw new Error(
      `Player identity mismatch for live snapshot event ${eventId}; missing=${missingPlayers.sort((a, b) => a - b).join(',') || 'none'}; unexpected=${unexpectedPlayers.sort((a, b) => a - b).join(',') || 'none'}`,
    );
  }
  return matchesCurrentRoster ? 'current-roster' : 'published-event';
}

/**
 * Fetch validation is a single coherent boundary: event-live, fixtures, the
 * expected fixture set and the player/team baseline are all checked before a
 * V2 candidate can be staged. No Redis or PostgreSQL writes happen here.
 */
export function prepareCoherentLiveSnapshot(
  eventId: number,
  liveResponse: RawFPLEventLiveResponse,
  rawFixtures: RawFPLFixture[],
  referenceData: LiveSnapshotReferenceData,
  expectedFixtureIds: readonly number[],
  publishedLiveElementIds: readonly number[] = [],
): PreparedLiveSnapshot {
  if (!Number.isInteger(eventId) || eventId <= 0)
    throw new Error(`Invalid live snapshot event ID: ${eventId}`);
  if (!Array.isArray(liveResponse.elements) || liveResponse.elements.length === 0) {
    throw new Error('FPL event live response contains no elements');
  }
  const liveElementIds = liveResponse.elements.map((element) => element.id);
  const liveIdentityBaseline = validateLiveElementIdentity(
    eventId,
    liveElementIds,
    referenceData,
    publishedLiveElementIds,
  );

  if (!Array.isArray(rawFixtures)) throw new Error('FPL fixtures response contains no fixtures');
  const wrongEventFixture = rawFixtures.find(
    (fixture) => fixture.event !== null && fixture.event !== eventId,
  );
  if (wrongEventFixture)
    throw new Error(`FPL fixtures response mixed event ${wrongEventFixture.event} into ${eventId}`);
  const rawFixtureIds = rawFixtures.map((fixture) => fixture.id);
  const expectedIds = [...expectedFixtureIds];
  if (expectedIds.length === 0 && rawFixtureIds.length > 0)
    throw new Error(`Unexpected fixtures for blank gameweek event ${eventId}`);
  if (
    new Set(rawFixtureIds).size !== rawFixtureIds.length ||
    new Set(expectedIds).size !== expectedIds.length
  )
    throw new Error(`Invalid fixture identity baseline for live snapshot event ${eventId}`);
  const actualFixtureIds = new Set(rawFixtureIds);
  const expectedFixtureSet = new Set(expectedIds);
  const missingFixtures = expectedIds.filter((id) => !actualFixtureIds.has(id));
  const unexpectedFixtures = rawFixtureIds.filter((id) => !expectedFixtureSet.has(id));
  if (missingFixtures.length > 0 || unexpectedFixtures.length > 0) {
    throw new Error(
      `Fixture identity mismatch for live snapshot event ${eventId}; missing=${missingFixtures.sort((a, b) => a - b).join(',') || 'none'}; unexpected=${unexpectedFixtures.sort((a, b) => a - b).join(',') || 'none'}`,
    );
  }
  const fixtureTeamIds = new Set(
    rawFixtures.flatMap((fixture) => [fixture.team_h, fixture.team_a]),
  );
  const missingTeams = [...fixtureTeamIds].filter(
    (teamId) => !referenceData.nameById.has(teamId) || !referenceData.shortNameById.has(teamId),
  );
  if (missingTeams.length > 0)
    throw new Error(`Missing live team metadata for IDs ${missingTeams.join(',')}`);

  const eventLives = prepareEventLives(eventId, liveResponse.elements);
  const fixtures = transformFixtures(rawFixtures);
  if (
    fixtures.length !== rawFixtures.length ||
    fixtures.some((fixture) => fixture.event !== eventId)
  ) {
    throw new Error(`Incomplete fixture transformation for live snapshot event ${eventId}`);
  }
  return {
    season: referenceData.season,
    eventId,
    eventLives,
    fixtures,
    state: resolveSnapshotState(fixtures),
    liveIdentityBaseline,
  };
}
