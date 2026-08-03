import { players } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { fplClient } from '../clients/fpl';
import { getActiveCacheSeason } from '../cache/cache-season';
import { liveSnapshotCache } from '../cache/operations';
import {
  buildPlayingMatches,
  computeFixtureSummedBonusByTeam,
  computeLiveBonusByTeam,
  type LiveBonusByTeam,
} from '../domain/live-bonus';
import type { LiveSnapshotState } from '../domain/live-snapshot';
import { fixtureRepository } from '../repositories/fixtures';
import { transformFixtures } from '../transformers/fixtures';
import type { Fixture, RawFPLEventLiveResponse, RawFPLFixture } from '../types';
import { logInfo, logWarn } from '../utils/logger';
import {
  persistPreparedEventLives,
  prepareEventLives,
  type PreparedEventLives,
} from './event-lives.service';
import {
  buildLiveFixtureViews,
  loadLiveFixtureTeamMaps,
  type LiveFixtureTeamMaps,
  type LiveFixtureViews,
} from './live-fixtures.service';
import { serializeBonusByTeam } from './live-bonus.service';

const REFERENCE_DATA_TTL_MS = 15 * 60 * 1000;

export interface LiveSnapshotReferenceData extends LiveFixtureTeamMaps {
  playerTeamById: Map<number, number>;
}

export interface PreparedLiveSnapshot {
  eventId: number;
  eventLives: PreparedEventLives;
  fixtures: Fixture[];
  fixtureViews: LiveFixtureViews;
  liveBonus: LiveBonusByTeam;
  liveBonusV2: LiveBonusByTeam;
  state: LiveSnapshotState;
  missingPlayerTeamCount: number;
}

export interface LiveSnapshotSyncResult {
  eventId: number;
  changed: boolean;
  revision: string;
  state: LiveSnapshotState;
  eventLiveCount: number;
  fixtureCount: number;
  fixtureTeamCount: number;
  bonusTeamCount: number;
  persistedFixtures: boolean;
  persistedEventLives: boolean;
}

type LiveSnapshotDependencies = {
  getEventLive: (eventId: number) => Promise<RawFPLEventLiveResponse>;
  getFixtures: (eventId: number) => Promise<RawFPLFixture[]>;
  getReferenceData: () => Promise<LiveSnapshotReferenceData>;
  publish: typeof liveSnapshotCache.publish;
  persistFixtures: (fixtures: Fixture[]) => Promise<Fixture[]>;
  persistEventLives: (prepared: PreparedEventLives) => Promise<readonly unknown[]>;
  now: () => Date;
};

let referenceDataMemo: {
  season: string;
  value: LiveSnapshotReferenceData;
  expiresAt: number;
} | null = null;

export function resetLiveSnapshotReferenceDataMemo(): void {
  referenceDataMemo = null;
}

export async function loadLiveSnapshotReferenceData(): Promise<LiveSnapshotReferenceData> {
  const season = await getActiveCacheSeason();
  if (
    referenceDataMemo &&
    referenceDataMemo.season === season &&
    referenceDataMemo.expiresAt > Date.now()
  ) {
    return referenceDataMemo.value;
  }

  const db = await getDb();
  const [teamMaps, playerRows] = await Promise.all([
    loadLiveFixtureTeamMaps(),
    db.select({ id: players.id, teamId: players.teamId }).from(players),
  ]);
  const value: LiveSnapshotReferenceData = {
    ...teamMaps,
    playerTeamById: new Map(playerRows.map((row) => [row.id, row.teamId])),
  };
  referenceDataMemo = { season, value, expiresAt: Date.now() + REFERENCE_DATA_TTL_MS };
  return value;
}

function resolveSnapshotState(fixtures: readonly Fixture[]): LiveSnapshotState {
  if (
    fixtures.some(
      (fixture) => fixture.started === true && !fixture.finished && !fixture.finishedProvisional,
    )
  ) {
    return 'live';
  }
  if (fixtures.every((fixture) => fixture.finished || fixture.finishedProvisional)) {
    return 'settled';
  }
  return 'scheduled';
}

export function prepareLiveSnapshot(
  eventId: number,
  liveResponse: RawFPLEventLiveResponse,
  rawFixtures: RawFPLFixture[],
  referenceData: LiveSnapshotReferenceData,
): PreparedLiveSnapshot {
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error(`Invalid live snapshot event ID: ${eventId}`);
  }
  if (!Array.isArray(liveResponse.elements) || liveResponse.elements.length === 0) {
    throw new Error('FPL event live response contains no elements');
  }
  if (!Array.isArray(rawFixtures) || rawFixtures.length === 0) {
    throw new Error('FPL fixtures response contains no fixtures');
  }
  const wrongEventFixture = rawFixtures.find(
    (fixture) => fixture.event !== null && fixture.event !== eventId,
  );
  if (wrongEventFixture) {
    throw new Error(
      `FPL fixtures response mixed event ${wrongEventFixture.event} into event ${eventId}`,
    );
  }

  const fixtureTeamIds = new Set(
    rawFixtures.flatMap((fixture) => [fixture.team_h, fixture.team_a]),
  );
  const missingFixtureTeamIds = [...fixtureTeamIds].filter(
    (teamId) => !referenceData.nameById.has(teamId) || !referenceData.shortNameById.has(teamId),
  );
  if (missingFixtureTeamIds.length > 0) {
    throw new Error(
      `Missing live snapshot team metadata for IDs: ${missingFixtureTeamIds
        .sort((a, b) => a - b)
        .join(', ')}`,
    );
  }

  const eventLives = prepareEventLives(eventId, liveResponse.elements);
  const rawFixtureIds = rawFixtures.map((fixture) => fixture.id);
  if (new Set(rawFixtureIds).size !== rawFixtureIds.length) {
    throw new Error(`FPL fixtures response contains duplicate fixture IDs for event ${eventId}`);
  }
  const transformedFixtures = transformFixtures(rawFixtures);
  const transformedIds = new Set(transformedFixtures.map((fixture) => fixture.id));
  const missingFixtureIds = rawFixtureIds.filter((fixtureId) => !transformedIds.has(fixtureId));
  const wrongTransformedEvent = transformedFixtures.find((fixture) => fixture.event !== eventId);
  if (
    missingFixtureIds.length > 0 ||
    transformedFixtures.length !== rawFixtures.length ||
    wrongTransformedEvent
  ) {
    throw new Error(
      `Incomplete fixture transformation for live snapshot event ${eventId}; ` +
        `missing IDs: ${missingFixtureIds.join(', ') || 'none'}`,
    );
  }
  const fixtures = transformedFixtures;
  const fixtureViews = buildLiveFixtureViews(fixtures, referenceData);
  const liveBonusV2 = serializeBonusByTeam(computeFixtureSummedBonusByTeam(fixtures));
  let missingPlayerTeamCount = 0;
  const livesWithTeam = eventLives.eventLives.flatMap((live) => {
    const teamId = referenceData.playerTeamById.get(live.elementId);
    if (teamId === undefined) {
      missingPlayerTeamCount += 1;
      return [];
    }
    return [{ ...live, teamId }];
  });
  const matches = buildPlayingMatches(fixtureViews.legacy);
  const liveBonus = serializeBonusByTeam(computeLiveBonusByTeam(matches, livesWithTeam));

  return {
    eventId,
    eventLives,
    fixtures,
    fixtureViews,
    liveBonus,
    liveBonusV2,
    state: resolveSnapshotState(fixtures),
    missingPlayerTeamCount,
  };
}

const defaultDependencies: LiveSnapshotDependencies = {
  getEventLive: (eventId) => fplClient.getEventLive(eventId),
  getFixtures: (eventId) => fplClient.getFixtures(eventId),
  getReferenceData: loadLiveSnapshotReferenceData,
  publish: (payload, options) => liveSnapshotCache.publish(payload, options),
  persistFixtures: (fixtures) => fixtureRepository.upsertBatch(fixtures),
  persistEventLives: persistPreparedEventLives,
  now: () => new Date(),
};

/**
 * Fetch, derive and publish a coherent live view from one pair of upstream
 * responses. Changed fixtures are durably persisted after every Redis view is
 * staged, but before the atomic swap exposes that revision to readers.
 */
export async function syncLiveSnapshot(
  eventId: number,
  options: {
    persistEventLives?: boolean;
    dependencies?: LiveSnapshotDependencies;
  } = {},
): Promise<LiveSnapshotSyncResult> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const startedAt = Date.now();
  const [liveResponse, rawFixtures, referenceData] = await Promise.all([
    dependencies.getEventLive(eventId),
    dependencies.getFixtures(eventId),
    dependencies.getReferenceData(),
  ]);
  const prepared = prepareLiveSnapshot(eventId, liveResponse, rawFixtures, referenceData);

  if (prepared.missingPlayerTeamCount > 0) {
    logWarn('Live snapshot skipped players missing stable team metadata', {
      eventId,
      count: prepared.missingPlayerTeamCount,
    });
  }

  let persistedFixtures = false;
  const published = await dependencies.publish(
    {
      eventId,
      state: prepared.state,
      eventLives: prepared.eventLives.eventLives,
      fixtures: prepared.fixtures,
      liveFixtures: prepared.fixtureViews.legacy,
      liveFixturesV2: prepared.fixtureViews.v2,
      liveBonus: prepared.liveBonus,
      liveBonusV2: prepared.liveBonusV2,
      checkedAt: dependencies.now(),
    },
    {
      beforeCommit: async () => {
        await dependencies.persistFixtures(prepared.fixtures);
        persistedFixtures = true;
      },
    },
  );

  const persistence: Promise<unknown>[] = [];
  if (options.persistEventLives) {
    persistence.push(dependencies.persistEventLives(prepared.eventLives));
  }
  await Promise.all(persistence);

  const result: LiveSnapshotSyncResult = {
    eventId,
    changed: published.changed,
    revision: published.meta.revision,
    state: prepared.state,
    eventLiveCount: prepared.eventLives.eventLives.length,
    fixtureCount: prepared.fixtures.length,
    fixtureTeamCount: Object.keys(prepared.fixtureViews.v2).length,
    bonusTeamCount: Object.keys(prepared.liveBonusV2).length,
    persistedFixtures,
    persistedEventLives: options.persistEventLives ?? false,
  };
  logInfo('Live snapshot sync completed', {
    ...result,
    durationMs: Date.now() - startedAt,
  });
  return result;
}
