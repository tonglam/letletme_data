import { sql } from 'drizzle-orm';

import { getDb } from '../db/singleton';
import { fplClient } from '../clients/fpl';
import { getActiveCacheSeason } from '../cache/cache-season';
import { liveSnapshotCache, playersCache } from '../cache/operations';
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
import { logInfo } from '../utils/logger';
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
import { getLiveSnapshotPlayerRosterVersion } from './live-snapshot-reference-state';

const REFERENCE_DATA_TTL_MS = 15 * 60 * 1000;
// "LLME" as a signed-safe 32-bit advisory-lock namespace. The event ID is
// the second key, so unrelated events can still prepare in parallel.
export const LIVE_SNAPSHOT_LOCK_NAMESPACE = 0x4c4c4d45;
const FIXTURE_SYNC_LOCK_ID = 0;

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
}

export interface LiveSnapshotSyncResult {
  eventId: number;
  changed: boolean;
  stale: boolean;
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
  getExpectedFixtureIds: (eventId: number) => Promise<readonly number[]>;
  getReferenceData: () => Promise<LiveSnapshotReferenceData>;
  serialize: <T>(eventId: number, operation: (checkedAt: Date) => Promise<T>) => Promise<T>;
  publish: typeof liveSnapshotCache.publish;
  persistFixtures: (fixtures: Fixture[]) => Promise<Fixture[]>;
  persistEventLives: (prepared: PreparedEventLives) => Promise<readonly unknown[]>;
};

/**
 * The optional Redis mutation guard is useful for broad cross-job conflicts,
 * but coherent live publication must never depend on a lease. A PostgreSQL
 * transaction advisory lock serializes the complete fetch/persist/publish flow
 * for one event across every worker process and is released by PostgreSQL if
 * the connection or transaction fails.
 */
export async function withLiveSnapshotSerialization<T>(
  eventId: number,
  operation: (checkedAt: Date) => Promise<T>,
): Promise<T> {
  return withLiveSnapshotEventsSerialization([eventId], operation);
}

/**
 * Fixture reschedules can invalidate more than one event at once. Acquire the
 * same mandatory locks in numeric order so retirement and the ownership write
 * stay serialized with every affected live publisher without deadlocking.
 */
export async function withLiveSnapshotEventsSerialization<T>(
  eventIds: readonly number[],
  operation: (checkedAt: Date) => Promise<T>,
): Promise<T> {
  const uniqueEventIds = [...new Set(eventIds)].sort((left, right) => left - right);
  if (
    uniqueEventIds.length === 0 ||
    uniqueEventIds.some((candidate) => !Number.isInteger(candidate) || candidate <= 0)
  ) {
    throw new Error(`Invalid live snapshot event IDs: ${eventIds.join(', ') || 'none'}`);
  }
  const db = await getDb();
  return db.transaction(async (tx) => {
    for (const lockedEventId of uniqueEventIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${LIVE_SNAPSHOT_LOCK_NAMESPACE}, ${lockedEventId})`,
      );
    }
    const rows = await tx.execute<{ checkedAt: Date | string }>(
      sql`SELECT clock_timestamp() AS "checkedAt"`,
    );
    const checkedAt =
      rows[0]?.checkedAt instanceof Date
        ? rows[0].checkedAt
        : new Date(String(rows[0]?.checkedAt ?? ''));
    if (!Number.isFinite(checkedAt.getTime())) {
      throw new Error('PostgreSQL returned an invalid live snapshot ordering timestamp');
    }
    return operation(checkedAt);
  });
}

/**
 * Fixture ownership discovery and mutation use a mandatory global lane before
 * taking affected event locks. This prevents two fixture syncs from observing
 * the same prior owner and leaving the later intermediate event's snapshot
 * behind when the optional Redis mutation guard is disabled.
 */
export async function withFixtureSyncSerialization<TContext, TResult>(
  prepare: () => Promise<{ eventIds: readonly number[]; context: TContext }>,
  operation: (context: TContext) => Promise<TResult>,
): Promise<TResult> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${LIVE_SNAPSHOT_LOCK_NAMESPACE}, ${FIXTURE_SYNC_LOCK_ID})`,
    );
    const plan = await prepare();
    const uniqueEventIds = [...new Set(plan.eventIds)].sort((left, right) => left - right);
    if (uniqueEventIds.some((candidate) => !Number.isInteger(candidate) || candidate <= 0)) {
      throw new Error(`Invalid fixture sync event IDs: ${plan.eventIds.join(', ')}`);
    }
    for (const lockedEventId of uniqueEventIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${LIVE_SNAPSHOT_LOCK_NAMESPACE}, ${lockedEventId})`,
      );
    }
    return operation(plan.context);
  });
}

let referenceDataMemo: {
  season: string;
  playerRosterVersion: number;
  value: LiveSnapshotReferenceData;
  expiresAt: number;
} | null = null;

export function resetLiveSnapshotReferenceDataMemo(): void {
  referenceDataMemo = null;
}

export async function loadLiveSnapshotReferenceData(): Promise<LiveSnapshotReferenceData> {
  const season = await getActiveCacheSeason();
  const playerRosterVersion = getLiveSnapshotPlayerRosterVersion();
  if (
    referenceDataMemo &&
    referenceDataMemo.season === season &&
    referenceDataMemo.playerRosterVersion === playerRosterVersion &&
    referenceDataMemo.expiresAt > Date.now()
  ) {
    return referenceDataMemo.value;
  }

  const [teamMaps, currentPlayers] = await Promise.all([
    loadLiveFixtureTeamMaps(),
    playersCache.get(),
  ]);
  if (!currentPlayers || currentPlayers.length === 0) {
    throw new Error(
      `Current-season Player:${season} roster is missing; refusing to prepare a live snapshot`,
    );
  }
  const playerTeamById = buildCurrentSeasonPlayerTeamMap(currentPlayers, season);
  const value: LiveSnapshotReferenceData = {
    ...teamMaps,
    playerTeamById,
  };
  referenceDataMemo = {
    season,
    playerRosterVersion,
    value,
    expiresAt: Date.now() + REFERENCE_DATA_TTL_MS,
  };
  return value;
}

export function buildCurrentSeasonPlayerTeamMap(
  currentPlayers: readonly { id: number; teamId: number }[],
  season: string,
): Map<number, number> {
  const playerTeamById = new Map<number, number>();
  for (const player of currentPlayers) {
    if (
      !Number.isInteger(player.id) ||
      player.id <= 0 ||
      !Number.isInteger(player.teamId) ||
      player.teamId <= 0
    ) {
      throw new Error(`Current-season Player:${season} roster contains invalid player identity`);
    }
    if (playerTeamById.has(player.id)) {
      throw new Error(`Current-season Player:${season} roster contains duplicate player IDs`);
    }
    playerTeamById.set(player.id, player.teamId);
  }
  return playerTeamById;
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
  expectedFixtureIds: readonly number[],
): PreparedLiveSnapshot {
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error(`Invalid live snapshot event ID: ${eventId}`);
  }
  if (!Array.isArray(liveResponse.elements) || liveResponse.elements.length === 0) {
    throw new Error('FPL event live response contains no elements');
  }
  const liveElementIds = liveResponse.elements.map((element) => element.id);
  if (new Set(liveElementIds).size !== liveElementIds.length) {
    throw new Error(`FPL event live response contains duplicate element IDs for event ${eventId}`);
  }
  const expectedLiveElementIds = [...referenceData.playerTeamById.keys()];
  if (expectedLiveElementIds.length === 0) {
    throw new Error(
      `No current-season player identity baseline for live snapshot event ${eventId}`,
    );
  }
  const liveElementIdSet = new Set(liveElementIds);
  const expectedLiveElementIdSet = new Set(expectedLiveElementIds);
  const missingLiveElementIds = expectedLiveElementIds.filter(
    (elementId) => !liveElementIdSet.has(elementId),
  );
  const unexpectedLiveElementIds = liveElementIds.filter(
    (elementId) => !expectedLiveElementIdSet.has(elementId),
  );
  if (missingLiveElementIds.length > 0 || unexpectedLiveElementIds.length > 0) {
    throw new Error(
      `Player identity mismatch for live snapshot event ${eventId}; ` +
        `missing expected IDs: ${missingLiveElementIds.sort((a, b) => a - b).join(', ') || 'none'}; ` +
        `unexpected IDs: ${unexpectedLiveElementIds.sort((a, b) => a - b).join(', ') || 'none'}`,
    );
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
  const expectedIds = [...expectedFixtureIds];
  if (expectedIds.length === 0) {
    throw new Error(`No persisted fixture identity baseline for live snapshot event ${eventId}`);
  }
  if (new Set(expectedIds).size !== expectedIds.length) {
    throw new Error(`Persisted fixture identity baseline contains duplicates for event ${eventId}`);
  }
  const rawIdSet = new Set(rawFixtureIds);
  const expectedIdSet = new Set(expectedIds);
  const missingExpectedIds = expectedIds.filter((fixtureId) => !rawIdSet.has(fixtureId));
  const unexpectedIds = rawFixtureIds.filter((fixtureId) => !expectedIdSet.has(fixtureId));
  if (missingExpectedIds.length > 0 || unexpectedIds.length > 0) {
    throw new Error(
      `Fixture identity mismatch for live snapshot event ${eventId}; ` +
        `missing expected IDs: ${missingExpectedIds.sort((a, b) => a - b).join(', ') || 'none'}; ` +
        `unexpected IDs: ${unexpectedIds.sort((a, b) => a - b).join(', ') || 'none'}`,
    );
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
  const livesWithTeam = eventLives.eventLives.map((live) => ({
    ...live,
    teamId: referenceData.playerTeamById.get(live.elementId)!,
  }));
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
  };
}

const defaultDependencies: LiveSnapshotDependencies = {
  getEventLive: (eventId) => fplClient.getEventLive(eventId),
  getFixtures: (eventId) => fplClient.getFixtures(eventId),
  getExpectedFixtureIds: async (eventId) =>
    (await fixtureRepository.findByEvent(eventId)).map((fixture) => fixture.id),
  getReferenceData: loadLiveSnapshotReferenceData,
  serialize: withLiveSnapshotSerialization,
  publish: (payload, options) => liveSnapshotCache.publish(payload, options),
  persistFixtures: (fixtures) => fixtureRepository.upsertBatch(fixtures),
  persistEventLives: persistPreparedEventLives,
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
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error(`Invalid live snapshot event ID: ${eventId}`);
  }
  return dependencies.serialize(eventId, async (checkedAt) => {
    // The shared PostgreSQL clock is read after taking the advisory lock and
    // before either upstream request starts. Redis fences on the same token.
    const [liveResponse, rawFixtures, expectedFixtureIds, referenceData] = await Promise.all([
      dependencies.getEventLive(eventId),
      dependencies.getFixtures(eventId),
      dependencies.getExpectedFixtureIds(eventId),
      dependencies.getReferenceData(),
    ]);
    const prepared = prepareLiveSnapshot(
      eventId,
      liveResponse,
      rawFixtures,
      referenceData,
      expectedFixtureIds,
    );

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
        checkedAt,
      },
      {
        beforeCommit: async () => {
          await dependencies.persistFixtures(prepared.fixtures);
          persistedFixtures = true;
        },
      },
    );

    let persistedEventLives = false;
    if (options.persistEventLives && !published.stale) {
      await dependencies.persistEventLives(prepared.eventLives);
      persistedEventLives = true;
    }

    const result: LiveSnapshotSyncResult = {
      eventId,
      changed: published.changed,
      stale: published.stale,
      revision: published.meta.revision,
      state: published.meta.state,
      eventLiveCount: published.meta.eventLiveCount,
      fixtureCount: published.meta.fixtureCount,
      fixtureTeamCount: published.meta.fixtureTeamCount,
      bonusTeamCount: published.meta.bonusTeamCount,
      persistedFixtures,
      persistedEventLives,
    };
    logInfo('Live snapshot sync completed', {
      ...result,
      durationMs: Date.now() - startedAt,
    });
    return result;
  });
}
