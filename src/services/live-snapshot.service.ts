import { createHash, randomUUID } from 'node:crypto';

import { and, eq, isNull, lte, or } from 'drizzle-orm';

import {
  publishLiveSnapshotCache,
  readLiveSnapshotCache,
  type LiveSnapshotCacheContents,
  type LiveSnapshotCachePayload,
} from '../cache/live-snapshot-cache';
import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import { fplClient } from '../clients/fpl';
import { eventsInFpl } from '../db/schemas/index.schema';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import type { DbOrTransaction } from '../db/singleton';
import type { EventLive } from '../domain/event-lives';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { LiveSnapshotState } from '../domain/live-snapshot';
import { createFixtureRepository, fixtureRepository } from '../repositories/fixtures';
import { createPlayerRepository } from '../repositories/players';
import { createTeamRepository } from '../repositories/teams';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { transformFixtures } from '../transformers/fixtures';
import type { Fixture, Player, RawFPLEventLiveResponse, RawFPLFixture, Team } from '../types';
import { postgresJsonbCanonicalJson } from '../utils/content-hash';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import {
  persistPreparedEventLives,
  prepareEventLives,
  type PreparedEventLives,
} from './event-lives.service';
import { createLiveFixtureTeamMaps, type LiveFixtureTeamMaps } from './live-fixtures.service';
import { withCoreSnapshotReadLock } from './core-snapshot-persistence.service';
import { refreshPlayerSeasonSummaries } from './player-season-summaries.service';
import { withMutationScopes } from '../utils/mutation-scopes';

const LIVE_SOURCE_STALE_AFTER_MS = 60_000;

export interface LiveSnapshotReferenceData extends LiveFixtureTeamMaps {
  readonly season: string;
  readonly playerTeamById: Map<number, number>;
}

export interface PreparedLiveSnapshot {
  readonly season: string;
  readonly eventId: number;
  readonly eventLives: PreparedEventLives;
  readonly fixtures: Fixture[];
  readonly state: LiveSnapshotState;
}

export interface LiveSnapshotSyncResult {
  readonly eventId: number;
  readonly changed: boolean;
  readonly stale: boolean;
  readonly revision: number | null;
  readonly publicationId: string | null;
  readonly state: LiveSnapshotState;
  readonly eventLiveCount: number;
  readonly fixtureCount: number;
  readonly fixtureTeamCount: number;
  readonly bonusTeamCount: number;
  readonly persistedFixtures: boolean;
  readonly persistedEventLives: boolean;
}

export interface LiveSnapshotDurablePersistenceRequest {
  readonly season: FplSeasonRef;
  readonly eventId: number;
  readonly checkedAt: Date;
  readonly prepared: PreparedLiveSnapshot;
  readonly persistFixtures: boolean;
  readonly persistEventLives: boolean;
  readonly persistEventLivesIfMissing?: boolean;
  readonly persistEventLivesIfStaleAt?: Date | null;
  readonly finalizeEvent?: boolean;
}

export interface LiveSnapshotDurablePersistenceResult {
  readonly accepted: boolean;
  readonly winnerCheckedAt: Date;
  readonly persistedFixtures: boolean;
  readonly persistedEventLives: boolean;
}

function publicationItemProof(name: 'eventLive' | 'fixtures', payload: unknown) {
  const serialized = postgresJsonbCanonicalJson(payload);
  return {
    name,
    payload,
    count: Array.isArray(payload)
      ? payload.length
      : payload && typeof payload === 'object'
        ? Object.keys(payload).length
        : 1,
    checksum: createHash('sha256').update(serialized, 'utf8').digest('hex'),
  } as const;
}

export interface LiveSnapshotDependencies {
  readonly getEventLive: (eventId: number) => Promise<RawFPLEventLiveResponse>;
  readonly getFixtures: (eventId: number) => Promise<RawFPLFixture[]>;
  readonly getExpectedFixtureIds: (
    season: FplSeasonRef,
    eventId: number,
  ) => Promise<readonly number[]>;
  readonly getReferenceData: (season: FplSeasonRef) => Promise<LiveSnapshotReferenceData>;
  readonly readOrderingTimestamp: () => Promise<Date>;
  readonly persistDurably: (
    request: LiveSnapshotDurablePersistenceRequest,
  ) => Promise<LiveSnapshotDurablePersistenceResult>;
  readonly readPublished: (
    seasonCode: string,
    eventId: number,
  ) => Promise<LiveSnapshotCacheContents | null>;
  readonly publish: typeof publishLiveSnapshotCache;
}

export interface LiveSnapshotSyncOptions {
  readonly persistEventLives?: boolean;
  readonly finalizeEvent?: boolean;
  readonly trigger?: 'cron' | 'manual' | 'cascade' | 'queue';
  readonly mutationScopes?: readonly string[];
  readonly dependencies?: LiveSnapshotDependencies;
}

function fixtureTeamCount(fixtures: readonly Fixture[]): number {
  return new Set(fixtures.flatMap((fixture) => [fixture.teamH, fixture.teamA])).size;
}

function bonusTeamCount(): number {
  // Official event-live totals already include projected/final bonus.  There is
  // intentionally no locally calculated bonus publication anymore.
  return 0;
}

export function buildCurrentSeasonPlayerTeamMap(
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
  return {
    season: season.seasonCode,
    ...createLiveFixtureTeamMaps(teams),
    playerTeamById: buildCurrentSeasonPlayerTeamMap(players, season.seasonCode),
  };
}

export async function loadLiveSnapshotReferenceData(
  season: FplSeasonRef,
): Promise<LiveSnapshotReferenceData> {
  const cached = await readCoreSnapshotCache(season.seasonCode);
  if (cached) {
    return referenceDataFromCore(season, cached.teams, cached.players);
  }

  return withCoreSnapshotReadLock(season, async (transaction) => {
    const [teams, players] = await Promise.all([
      createTeamRepository(transaction).findAll(season),
      createPlayerRepository(transaction).findAll(season),
    ]);
    return referenceDataFromCore(season, teams, players);
  });
}

function resolveSnapshotState(fixtures: readonly Fixture[]): LiveSnapshotState {
  if (fixtures.length === 0) return 'scheduled';
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
  // Keep the event live between fixtures once any fixture has started or
  // reached provisional completion. The live publication still carries the
  // authoritative rows for the whole event; `scheduled` is reserved for a
  // pre-kickoff event with no started or provisionally settled fixture.
  return fixtures.some(
    (fixture) => fixture.started || fixture.finished || fixture.finishedProvisional,
  )
    ? 'live'
    : 'scheduled';
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
  const expectedLiveElementIds = [...referenceData.playerTeamById.keys()];
  if (
    new Set(liveElementIds).size !== liveElementIds.length ||
    new Set(expectedLiveElementIds).size !== expectedLiveElementIds.length
  ) {
    throw new Error(`Duplicate player identity in live snapshot event ${eventId}`);
  }
  const actualPlayerIds = new Set(liveElementIds);
  const expectedPlayerIds = new Set(expectedLiveElementIds);
  const missingPlayers = expectedLiveElementIds.filter((id) => !actualPlayerIds.has(id));
  const unexpectedPlayers = liveElementIds.filter((id) => !expectedPlayerIds.has(id));
  if (missingPlayers.length > 0 || unexpectedPlayers.length > 0) {
    throw new Error(
      `Player identity mismatch for live snapshot event ${eventId}; ` +
        `missing=${missingPlayers.sort((a, b) => a - b).join(',') || 'none'}; ` +
        `unexpected=${unexpectedPlayers.sort((a, b) => a - b).join(',') || 'none'}`,
    );
  }

  if (!Array.isArray(rawFixtures)) {
    throw new Error('FPL fixtures response contains no fixtures');
  }
  const wrongEventFixture = rawFixtures.find(
    (fixture) => fixture.event !== null && fixture.event !== eventId,
  );
  if (wrongEventFixture) {
    throw new Error(`FPL fixtures response mixed event ${wrongEventFixture.event} into ${eventId}`);
  }
  const rawFixtureIds = rawFixtures.map((fixture) => fixture.id);
  const expectedIds = [...expectedFixtureIds];
  if (expectedIds.length === 0 && rawFixtureIds.length > 0) {
    throw new Error(`Unexpected fixtures for blank gameweek event ${eventId}`);
  }
  if (
    expectedIds.length > 0 &&
    (new Set(rawFixtureIds).size !== rawFixtureIds.length ||
      new Set(expectedIds).size !== expectedIds.length)
  ) {
    throw new Error(`Invalid fixture identity baseline for live snapshot event ${eventId}`);
  }
  const actualFixtureIds = new Set(rawFixtureIds);
  const expectedFixtureSet = new Set(expectedIds);
  const missingFixtures = expectedIds.filter((id) => !actualFixtureIds.has(id));
  const unexpectedFixtures = rawFixtureIds.filter((id) => !expectedFixtureSet.has(id));
  if (missingFixtures.length > 0 || unexpectedFixtures.length > 0) {
    throw new Error(
      `Fixture identity mismatch for live snapshot event ${eventId}; ` +
        `missing=${missingFixtures.sort((a, b) => a - b).join(',') || 'none'}; ` +
        `unexpected=${unexpectedFixtures.sort((a, b) => a - b).join(',') || 'none'}`,
    );
  }

  const fixtureTeamIds = new Set(
    rawFixtures.flatMap((fixture) => [fixture.team_h, fixture.team_a]),
  );
  const missingTeams = [...fixtureTeamIds].filter(
    (teamId) => !referenceData.nameById.has(teamId) || !referenceData.shortNameById.has(teamId),
  );
  if (missingTeams.length > 0) {
    throw new Error(`Missing live team metadata for IDs ${missingTeams.join(',')}`);
  }

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
  };
}

async function claimLiveSnapshotFence(
  transaction: DbOrTransaction,
  season: FplSeasonRef,
  eventId: number,
  checkedAt: Date,
): Promise<{ accepted: boolean; winnerCheckedAt: Date }> {
  const claimed = await transaction
    .update(eventsInFpl)
    .set({ liveSnapshotCheckedAt: checkedAt })
    .where(
      and(
        eq(eventsInFpl.seasonId, season.seasonId),
        eq(eventsInFpl.eventId, eventId),
        or(
          isNull(eventsInFpl.liveSnapshotCheckedAt),
          lte(eventsInFpl.liveSnapshotCheckedAt, checkedAt),
        ),
      ),
    )
    .returning({ checkedAt: eventsInFpl.liveSnapshotCheckedAt });
  if (claimed[0]) {
    return { accepted: true, winnerCheckedAt: claimed[0].checkedAt ?? checkedAt };
  }

  const current = await transaction
    .select({ checkedAt: eventsInFpl.liveSnapshotCheckedAt })
    .from(eventsInFpl)
    .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)))
    .limit(1);
  if (!current[0]) {
    throw new DatabaseError(`Cannot persist live data for missing event ${eventId}`);
  }
  const winnerCheckedAt = current[0].checkedAt;
  if (!winnerCheckedAt || winnerCheckedAt.getTime() <= checkedAt.getTime()) {
    throw new DatabaseError('Live snapshot ordering fence did not advance');
  }
  return { accepted: false, winnerCheckedAt };
}

export async function persistLiveSnapshotDurably(
  request: LiveSnapshotDurablePersistenceRequest,
): Promise<LiveSnapshotDurablePersistenceResult> {
  const { season, eventId, checkedAt, prepared } = request;
  if (prepared.season !== season.seasonCode || prepared.eventId !== eventId) {
    throw new DatabaseError('Live snapshot persistence scope does not match its payload');
  }
  if (request.finalizeEvent && !request.persistEventLives) {
    throw new DatabaseError('Final live publication requires durable event-live persistence');
  }

  const result = await withCoreSnapshotReadLock(season, async (transaction) => {
    const fence = await claimLiveSnapshotFence(transaction, season, eventId, checkedAt);
    if (!fence.accepted) {
      return {
        ...fence,
        persistedFixtures: false,
        persistedEventLives: false,
      };
    }

    const currentEvent = await transaction
      .select({ liveFactsPersistedAt: eventsInFpl.liveFactsPersistedAt })
      .from(eventsInFpl)
      .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)))
      .limit(1);
    const persistEventLives =
      request.persistEventLives &&
      (!request.persistEventLivesIfMissing ||
        request.finalizeEvent === true ||
        currentEvent[0]?.liveFactsPersistedAt === null ||
        (request.persistEventLivesIfStaleAt instanceof Date &&
          Number.isFinite(request.persistEventLivesIfStaleAt.getTime()) &&
          currentEvent[0]?.liveFactsPersistedAt !== null &&
          currentEvent[0] !== undefined &&
          currentEvent[0].liveFactsPersistedAt.getTime() <
            request.persistEventLivesIfStaleAt.getTime()));

    if (request.persistFixtures) {
      await createFixtureRepository(transaction).upsertBatch(season, prepared.fixtures);
    }
    if (persistEventLives) {
      await persistPreparedEventLives(season, prepared.eventLives, transaction);
      await transaction
        .update(eventsInFpl)
        .set({ liveFactsPersistedAt: checkedAt })
        .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)));
    }
    if (request.finalizeEvent) {
      const finalized = await transaction
        .update(eventsInFpl)
        .set({ liveSnapshotFinalizedAt: checkedAt })
        .where(
          and(
            eq(eventsInFpl.seasonId, season.seasonId),
            eq(eventsInFpl.eventId, eventId),
            eq(eventsInFpl.finished, true),
            eq(eventsInFpl.dataChecked, true),
          ),
        )
        .returning({ eventId: eventsInFpl.eventId });
      if (finalized.length !== 1) {
        throw new DatabaseError(`Event ${eventId} is not ready for final live publication`);
      }
    }
    return {
      accepted: true,
      winnerCheckedAt: fence.winnerCheckedAt,
      persistedFixtures: request.persistFixtures,
      persistedEventLives: persistEventLives,
    };
  });

  if (result.persistedEventLives) {
    try {
      // Keep the reporting refresh outside the canonical live-write
      // transaction. Its failure cannot roll back durable FPL facts and the
      // hourly repair job will retry the missing revision.
      await refreshPlayerSeasonSummaries(season);
    } catch (error) {
      logError('Player season summary refresh failed after durable live write', error, {
        season: season.seasonCode,
        eventId,
      });
    }
  }

  return result;
}

function toCachePayload(prepared: PreparedLiveSnapshot): LiveSnapshotCachePayload {
  return {
    season: prepared.season,
    eventId: prepared.eventId,
    state: prepared.state,
    eventLives: prepared.eventLives.eventLives,
    fixtures: prepared.fixtures,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return postgresJsonbCanonicalJson(left) === postgresJsonbCanonicalJson(right);
  } catch {
    return false;
  }
}

function snapshotContentMatches(
  active: LiveSnapshotCacheContents | null,
  candidate: LiveSnapshotCachePayload,
): boolean {
  return Boolean(
    active &&
      active.state === candidate.state &&
      sameJson(active.eventLives, candidate.eventLives) &&
      sameJson(active.fixtures, candidate.fixtures),
  );
}

const defaultDependencies: LiveSnapshotDependencies = {
  getEventLive: (eventId) => fplClient.getEventLive(eventId),
  getFixtures: (eventId) => fplClient.getFixtures(eventId),
  getExpectedFixtureIds: async (season, eventId) =>
    (await fixtureRepository.findByEvent(season, eventId)).map((fixture) => fixture.id),
  getReferenceData: loadLiveSnapshotReferenceData,
  readOrderingTimestamp: async () => (await readDatabaseOrderingTimestamp()).date,
  persistDurably: persistLiveSnapshotDurably,
  readPublished: readLiveSnapshotCache,
  publish: publishLiveSnapshotCache,
};

export async function recoverPendingLiveSnapshotPublication(
  season: FplSeasonRef,
  eventId: number,
): Promise<'none' | 'activated'> {
  const cached = await readLiveSnapshotCache(season.seasonCode, eventId);
  if (!cached) return 'none';
  const active = await syncOperationsRepository.findActivePublication('fpl:live', season, eventId);
  if (active?.publicationId === cached.manifest.publicationId) return 'none';

  const pending = await syncOperationsRepository.findPublicationById(cached.manifest.publicationId);
  if (
    !pending ||
    pending.status !== 'staging' ||
    pending.dataset !== 'fpl:live' ||
    pending.seasonId !== season.seasonId ||
    pending.eventId !== eventId ||
    pending.revision !== cached.manifest.revision ||
    !pending.sourceRunId
  ) {
    throw new DatabaseError(
      'Active live cache manifest has no recoverable ops publication',
      'LIVE_PUBLICATION_RECOVERY_CONTRACT_MISMATCH',
    );
  }
  await syncOperationsRepository.activatePublication({
    publicationId: pending.publicationId,
    dataset: 'fpl:live',
    season,
    eventId,
    sourceRunId: pending.sourceRunId,
    manifest: cached.manifest,
  });
  return 'activated';
}

export async function syncLiveSnapshot(
  season: FplSeasonRef,
  eventId: number,
  options: LiveSnapshotSyncOptions = {},
): Promise<LiveSnapshotSyncResult> {
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error(`Invalid live snapshot event ID: ${eventId}`);
  }
  const dependencies = options.dependencies ?? defaultDependencies;
  const persistDurably = async (request: LiveSnapshotDurablePersistenceRequest) => {
    const scopes = options.mutationScopes ?? [];
    if (scopes.length === 0) return dependencies.persistDurably(request);
    return withMutationScopes(
      {
        queueName: 'live-data',
        jobName: 'live-snapshot',
        eventId,
        scopes: [...scopes],
      },
      () => dependencies.persistDurably(request),
    );
  };
  const startedAt = Date.now();
  if (!options.dependencies) {
    await recoverPendingLiveSnapshotPublication(season, eventId);
  }

  const sourceRunId = randomUUID();
  await syncOperationsRepository.startRun({
    runId: sourceRunId,
    provider: 'fpl',
    lane: 'live',
    scope: 'live-snapshot',
    season,
    eventId,
    mode: options.persistEventLives ? 'durable' : 'cache',
    trigger: options.trigger ?? 'queue',
  });

  let publicationId: string | null = null;
  let cachePublished = false;
  let fetchedAt: number | null = null;
  try {
    const checkedAt = await dependencies.readOrderingTimestamp();
    const [liveResponse, rawFixtures, expectedFixtureIds, referenceData, active] =
      await Promise.all([
        dependencies.getEventLive(eventId),
        dependencies.getFixtures(eventId),
        dependencies.getExpectedFixtureIds(season, eventId),
        dependencies.getReferenceData(season),
        dependencies.readPublished(season.seasonCode, eventId),
      ]);
    fetchedAt = Date.now();
    if (referenceData.season !== season.seasonCode) {
      throw new DatabaseError('Live reference data belongs to another FPL season');
    }
    const prepared = prepareLiveSnapshot(
      eventId,
      liveResponse,
      rawFixtures,
      referenceData,
      expectedFixtureIds,
    );
    const payload = toCachePayload(prepared);
    const changed = !snapshotContentMatches(active, payload);

    if (!changed) {
      let persistedFixtures = false;
      let persistedEventLives = false;
      // Fixture flags are the lifecycle source of truth even for cache-only
      // polls. Persisting them independently of event-live durability prevents
      // a stale database fixture from keeping the orchestrator in LIVE_ACTIVE.
      const durable = await persistDurably({
        season,
        eventId,
        checkedAt,
        prepared,
        persistFixtures: true,
        persistEventLives: options.persistEventLives === true || options.finalizeEvent === true,
        persistEventLivesIfMissing: true,
        persistEventLivesIfStaleAt: active?.manifest.sourceCheckedAt
          ? new Date(active.manifest.sourceCheckedAt)
          : null,
        finalizeEvent: options.finalizeEvent,
      });
      persistedFixtures = durable.persistedFixtures;
      persistedEventLives = durable.persistedEventLives;
      await syncOperationsRepository.finishRun(sourceRunId, {
        status: 'skipped',
        completedItems:
          (persistedEventLives ? prepared.eventLives.eventLives.length : 0) +
          (persistedFixtures ? prepared.fixtures.length : 0),
        skippedItems:
          (persistedEventLives ? 0 : prepared.eventLives.eventLives.length) +
          (persistedFixtures ? 0 : prepared.fixtures.length),
        dataChanged: false,
      });
      const result: LiveSnapshotSyncResult = {
        eventId,
        changed: false,
        stale: false,
        revision: active?.manifest.revision ?? null,
        publicationId: active?.manifest.publicationId ?? null,
        state: prepared.state,
        eventLiveCount: prepared.eventLives.eventLives.length,
        fixtureCount: prepared.fixtures.length,
        fixtureTeamCount: fixtureTeamCount(prepared.fixtures),
        bonusTeamCount: bonusTeamCount(),
        persistedFixtures,
        persistedEventLives,
      };
      const sourceAgeMs = Math.max(0, Date.now() - checkedAt.getTime());
      logInfo('Live snapshot content unchanged', {
        ...result,
        durationMs: Date.now() - startedAt,
        fetchDurationMs: (fetchedAt ?? Date.now()) - startedAt,
        publishDurationMs: 0,
        sourceCheckedAt: checkedAt.toISOString(),
        sourceAgeMs,
        stale: sourceAgeMs > LIVE_SOURCE_STALE_AFTER_MS,
      });
      return result;
    }

    publicationId = randomUUID();
    const staging = await syncOperationsRepository.preparePublication({
      publicationId,
      dataset: 'fpl:live',
      season,
      eventId,
      sourceRunId,
      manifest: {
        state: 'staging',
        sourceCheckedAt: checkedAt.toISOString(),
      },
    });
    let persistedFixtures = false;
    let persistedEventLives = false;
    const publishStartedAt = Date.now();
    const published = await dependencies.publish(payload, {
      revision: staging.revision,
      publicationId: staging.publicationId,
      sourceCheckedAt: checkedAt,
      afterStage: async (manifest) => {
        await syncOperationsRepository.stagePublicationItems(staging.publicationId, [
          publicationItemProof('eventLive', prepared.eventLives.eventLives),
          publicationItemProof('fixtures', prepared.fixtures),
        ]);
        if (manifest.items.some((item) => item.name !== 'eventLive' && item.name !== 'fixtures')) {
          throw new DatabaseError('Live publication contains unsupported items');
        }
      },
      beforeActivate: async () => {
        const durable = await persistDurably({
          season,
          eventId,
          checkedAt,
          prepared,
          persistFixtures: true,
          persistEventLives: options.persistEventLives === true || options.finalizeEvent === true,
          finalizeEvent: options.finalizeEvent,
        });
        persistedFixtures = durable.persistedFixtures;
        persistedEventLives = durable.persistedEventLives;
        return durable.accepted;
      },
    });
    if (!published.published) {
      await syncOperationsRepository.skipPublication(
        staging.publicationId,
        'A newer live publication already owns the cache scope',
      );
      await syncOperationsRepository.finishRun(sourceRunId, {
        status: 'skipped',
        completedItems:
          (persistedEventLives ? prepared.eventLives.eventLives.length : 0) +
          (persistedFixtures ? prepared.fixtures.length : 0),
        skippedItems:
          (persistedEventLives ? 0 : prepared.eventLives.eventLives.length) +
          (persistedFixtures ? 0 : prepared.fixtures.length),
        dataChanged: false,
      });
      return {
        eventId,
        changed: false,
        stale: true,
        revision: published.previousManifest?.revision ?? null,
        publicationId: published.previousManifest?.publicationId ?? null,
        state: prepared.state,
        eventLiveCount: prepared.eventLives.eventLives.length,
        fixtureCount: prepared.fixtures.length,
        fixtureTeamCount: fixtureTeamCount(prepared.fixtures),
        bonusTeamCount: bonusTeamCount(),
        persistedFixtures,
        persistedEventLives,
      };
    }
    cachePublished = true;
    const sourceAgeMs = Math.max(0, Date.now() - checkedAt.getTime());
    if (sourceAgeMs > LIVE_SOURCE_STALE_AFTER_MS) {
      logError(
        'Live snapshot source exceeded hard freshness threshold',
        new Error('LIVE_SOURCE_STALE'),
        {
          eventId,
          sourceCheckedAt: checkedAt.toISOString(),
          sourceAgeMs,
          thresholdMs: LIVE_SOURCE_STALE_AFTER_MS,
        },
      );
    }
    await syncOperationsRepository.activatePublication({
      publicationId: staging.publicationId,
      dataset: 'fpl:live',
      season,
      eventId,
      sourceRunId,
      manifest: published.manifest,
    });

    const result: LiveSnapshotSyncResult = {
      eventId,
      changed: true,
      stale: false,
      revision: staging.revision,
      publicationId: staging.publicationId,
      state: prepared.state,
      eventLiveCount: prepared.eventLives.eventLives.length,
      fixtureCount: prepared.fixtures.length,
      fixtureTeamCount: fixtureTeamCount(prepared.fixtures),
      bonusTeamCount: bonusTeamCount(),
      persistedFixtures,
      persistedEventLives,
    };
    logInfo('Live snapshot publication completed', {
      ...result,
      durationMs: Date.now() - startedAt,
      fetchDurationMs: (fetchedAt ?? Date.now()) - startedAt,
      publishDurationMs: Date.now() - publishStartedAt,
      sourceCheckedAt: checkedAt.toISOString(),
      sourceAgeMs,
      stale: sourceAgeMs > LIVE_SOURCE_STALE_AFTER_MS,
    });
    return result;
  } catch (error) {
    if (publicationId && !cachePublished) {
      await syncOperationsRepository.failPublication(publicationId, error).catch(() => undefined);
    } else if (!publicationId) {
      await syncOperationsRepository.failRun(sourceRunId, error).catch(() => undefined);
    }
    throw error;
  }
}

export function liveEventRowsFromSnapshot(snapshot: LiveSnapshotCacheContents): EventLive[] {
  return [...snapshot.eventLives];
}
