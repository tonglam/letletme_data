import { randomUUID } from 'node:crypto';

import { and, eq, isNull, lte, or } from 'drizzle-orm';

import {
  readLiveSnapshotCache,
  refreshLiveSnapshotHeartbeat,
  type LiveSnapshotCacheContents,
  type LiveSnapshotCachePayload,
} from '../cache/live-snapshot-cache';
import { prepareDataPublication } from '../cache/data-publication';
import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import { fplClient } from '../clients/fpl';
import { eventsInFpl } from '../db/schemas/index.schema';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import type { DbOrTransaction } from '../db/singleton';
import type { EventLive } from '../domain/event-lives';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { LiveSnapshotState } from '../domain/live-snapshot';
import { eventRepository } from '../repositories/events';
import { createFixtureRepository, fixtureRepository } from '../repositories/fixtures';
import { createPlayerRepository } from '../repositories/players';
import { createTeamRepository } from '../repositories/teams';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { dispatchDataPublicationOutbox } from '../repositories/data-publication-outbox';
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
import { reconcileDataPublication } from './data-publication-reconciler';
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
  readonly liveIdentityBaseline: 'current-roster' | 'published-event';
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
  /**
   * `advanced` owns both the durable-write and cache-publication fence.
   * `finalized-noop` confirms an immutable final checkpoint and may not publish
   * the newly fetched candidate. `superseded` may neither write nor publish.
   */
  readonly disposition: 'advanced' | 'finalized-noop' | 'superseded';
  readonly winnerCheckedAt: Date;
  readonly persistedFixtures: boolean;
  readonly persistedEventLives: boolean;
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
  readonly refreshHeartbeat?: (
    seasonCode: string,
    eventId: number,
    lastSuccessfulFetchAt: Date,
  ) => Promise<LiveSnapshotCacheContents | null>;
}

export interface LiveSnapshotSyncOptions {
  readonly persistEventLives?: boolean;
  readonly finalizeEvent?: boolean;
  readonly trigger?: 'cron' | 'manual' | 'cascade' | 'queue' | 'catchup' | 'reconcile';
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
  publishedLiveElementIds: readonly number[] = [],
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
    new Set(expectedLiveElementIds).size !== expectedLiveElementIds.length ||
    new Set(publishedLiveElementIds).size !== publishedLiveElementIds.length
  ) {
    throw new Error(`Duplicate player identity in live snapshot event ${eventId}`);
  }
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
    liveIdentityBaseline: matchesCurrentRoster ? 'current-roster' : 'published-event',
  };
}

async function claimLiveSnapshotFence(
  transaction: DbOrTransaction,
  season: FplSeasonRef,
  eventId: number,
  checkedAt: Date,
  allowFinalizedNoop: boolean,
): Promise<Pick<LiveSnapshotDurablePersistenceResult, 'disposition' | 'winnerCheckedAt'>> {
  const claimed = await transaction
    .update(eventsInFpl)
    .set({ liveSnapshotCheckedAt: checkedAt })
    .where(
      and(
        eq(eventsInFpl.seasonId, season.seasonId),
        eq(eventsInFpl.eventId, eventId),
        isNull(eventsInFpl.liveSnapshotFinalizedAt),
        or(
          isNull(eventsInFpl.liveSnapshotCheckedAt),
          lte(eventsInFpl.liveSnapshotCheckedAt, checkedAt),
        ),
      ),
    )
    .returning({ checkedAt: eventsInFpl.liveSnapshotCheckedAt });
  if (claimed[0]) {
    return { disposition: 'advanced', winnerCheckedAt: claimed[0].checkedAt ?? checkedAt };
  }

  const current = await transaction
    .select({
      checkedAt: eventsInFpl.liveSnapshotCheckedAt,
      finalizedAt: eventsInFpl.liveSnapshotFinalizedAt,
    })
    .from(eventsInFpl)
    .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)))
    .limit(1);
  if (!current[0]) {
    throw new DatabaseError(`Cannot persist live data for missing event ${eventId}`);
  }
  if (current[0].finalizedAt) {
    const finalizationReplayNoop = allowFinalizedNoop;
    logInfo('Live snapshot retained the immutable finalized checkpoint', {
      season: season.seasonCode,
      eventId,
      finalizedAt: current[0].finalizedAt.toISOString(),
      finalizationReplayNoop,
    });
    return {
      disposition: finalizationReplayNoop ? 'finalized-noop' : 'superseded',
      winnerCheckedAt: current[0].finalizedAt,
    };
  }
  const winnerCheckedAt = current[0].checkedAt;
  if (!winnerCheckedAt || winnerCheckedAt.getTime() <= checkedAt.getTime()) {
    throw new DatabaseError('Live snapshot ordering fence did not advance');
  }
  return { disposition: 'superseded', winnerCheckedAt };
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
    const fence = await claimLiveSnapshotFence(
      transaction,
      season,
      eventId,
      checkedAt,
      request.finalizeEvent === true,
    );
    if (fence.disposition !== 'advanced') {
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
      disposition: 'advanced' as const,
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
};

export async function recoverPendingLiveSnapshotPublication(
  season: FplSeasonRef,
  eventId: number,
): Promise<'none' | 'activated'> {
  const [cached, active, finalizedAt] = await Promise.all([
    readLiveSnapshotCache(season.seasonCode, eventId),
    syncOperationsRepository.findActivePublication('fpl:live', season, eventId),
    eventRepository.findLiveSnapshotFinalizedAt(season, eventId),
  ]);
  if (
    cached &&
    active?.publicationId === cached.manifest.publicationId &&
    active.revision === cached.manifest.revision
  ) {
    return 'none';
  }

  const result = await reconcileDataPublication(
    { dataset: 'fpl:live', seasonCode: season.seasonCode, eventId },
    season,
  );
  if (finalizedAt && result.status !== 'matched' && result.status !== 'repaired') {
    throw new DatabaseError(
      `Finalized event ${eventId} has no recoverable canonical live publication`,
      'LIVE_FINAL_PUBLICATION_MISSING',
    );
  }
  return result.status === 'repaired' ? 'activated' : 'none';
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

  let dbActivated = false;
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
    const lastSuccessfulFetchAt = await dependencies.readOrderingTimestamp();
    if (referenceData.season !== season.seasonCode) {
      throw new DatabaseError('Live reference data belongs to another FPL season');
    }
    const prepared = prepareLiveSnapshot(
      eventId,
      liveResponse,
      rawFixtures,
      referenceData,
      expectedFixtureIds,
      active?.eventLives.map((row) => row.elementId),
    );
    if (prepared.liveIdentityBaseline === 'published-event') {
      logInfo('Live snapshot retained the published event roster after core roster drift', {
        season: season.seasonCode,
        eventId,
        currentRosterCount: referenceData.playerTeamById.size,
        eventRosterCount: prepared.eventLives.eventLives.length,
        priorPublicationId: active?.manifest.publicationId ?? null,
      });
    }
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
        persistEventLivesIfStaleAt: active?.manifest.lastSuccessfulFetchAt
          ? new Date(active.manifest.lastSuccessfulFetchAt)
          : active?.manifest.sourceCheckedAt
            ? new Date(active.manifest.sourceCheckedAt)
            : null,
        finalizeEvent: options.finalizeEvent,
      });
      persistedFixtures = durable.persistedFixtures;
      persistedEventLives = durable.persistedEventLives;
      if (active && durable.disposition === 'advanced') {
        await (
          dependencies.refreshHeartbeat ??
          ((seasonCode: string, currentEventId: number, checkedAt: Date) =>
            refreshLiveSnapshotHeartbeat(seasonCode, currentEventId, checkedAt))
        )(season.seasonCode, eventId, lastSuccessfulFetchAt);
      }
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
      logInfo('Live snapshot content unchanged', {
        ...result,
        durationMs: Date.now() - startedAt,
        fetchDurationMs: (fetchedAt ?? Date.now()) - startedAt,
        publishDurationMs: 0,
        sourceCheckedAt: active?.manifest.sourceCheckedAt ?? null,
        lastSuccessfulFetchAt: lastSuccessfulFetchAt.toISOString(),
        sourceAgeMs: Math.max(0, Date.now() - lastSuccessfulFetchAt.getTime()),
        stale: false,
      });
      return result;
    }

    const livePublicationId = randomUUID();
    let persistedFixtures = false;
    let persistedEventLives = false;
    const publishStartedAt = Date.now();
    // Keep the immutable final/live facts, full publication manifest, item
    // proof, DB activation, and delivery receipt in one transaction. Redis is
    // rebuilt only from that committed proof after the transaction returns.
    const { staging, canonical, durable } = await withMutationScopes(
      {
        queueName: 'live-data',
        jobName: 'live-snapshot',
        eventId,
        scopes: [
          ...(options.mutationScopes ?? ['data-core:fixtures', `live-snapshot:event:${eventId}`]),
        ],
      },
      async () => {
        // The surrounding scope already pins the transaction for this whole
        // canonical phase; call the dependency directly to avoid nesting a
        // second scope transaction around the same write set.
        const durable = await dependencies.persistDurably({
          season,
          eventId,
          checkedAt,
          prepared,
          persistFixtures: true,
          persistEventLives: options.persistEventLives === true || options.finalizeEvent === true,
          finalizeEvent: options.finalizeEvent,
        });
        if (durable.disposition !== 'advanced') {
          // A finalized retry is an immutable no-op. It may reconcile the
          // already committed final publication before this fetch, but the
          // newly fetched payload can never allocate or activate a revision.
          return { staging: null, canonical: null, durable };
        }

        const staging = await syncOperationsRepository.preparePublication({
          publicationId: livePublicationId,
          dataset: 'fpl:live',
          season,
          eventId,
          sourceRunId,
          manifest: {
            state: 'staging',
            sourceCheckedAt: checkedAt.toISOString(),
            lastSuccessfulFetchAt: lastSuccessfulFetchAt.toISOString(),
          },
        });
        const canonical = prepareDataPublication({
          dataset: 'fpl:live',
          seasonCode: season.seasonCode,
          eventId,
          revision: staging.revision,
          publicationId: staging.publicationId,
          sourceCheckedAt: checkedAt,
          lastSuccessfulFetchAt,
          state: payload.state,
          items: [
            { name: 'eventLive', value: payload.eventLives },
            { name: 'fixtures', value: payload.fixtures },
          ],
        });
        await syncOperationsRepository.stagePublicationItems(
          staging.publicationId,
          canonical.manifest.items.map((item) => ({
            name: item.name as 'eventLive' | 'fixtures',
            payload: item.name === 'eventLive' ? payload.eventLives : payload.fixtures,
            count: item.count,
            checksum: item.sha256,
          })),
        );
        await syncOperationsRepository.activatePublication({
          publicationId: staging.publicationId,
          dataset: 'fpl:live',
          season,
          eventId,
          sourceRunId,
          manifest: canonical.manifest,
          outbox: { outboxId: randomUUID() },
        });
        return { staging, canonical, durable };
      },
    );
    persistedFixtures = durable.persistedFixtures;
    persistedEventLives = durable.persistedEventLives;
    if (durable.disposition !== 'advanced') {
      if (durable.disposition === 'finalized-noop' && !active) {
        throw new DatabaseError(
          `Finalized event ${eventId} has no active canonical live cache`,
          'LIVE_FINAL_PUBLICATION_MISSING',
        );
      }
      await syncOperationsRepository.finishRun(sourceRunId, {
        status: 'skipped',
        completedItems: 0,
        skippedItems: prepared.eventLives.eventLives.length + prepared.fixtures.length,
        dataChanged: false,
      });
      const retainedEventLives = active?.eventLives ?? prepared.eventLives.eventLives;
      const retainedFixtures = active?.fixtures ?? prepared.fixtures;
      return {
        eventId,
        changed: false,
        stale: durable.disposition === 'superseded',
        revision: active?.manifest.revision ?? null,
        publicationId: active?.manifest.publicationId ?? null,
        state: active?.state ?? prepared.state,
        eventLiveCount: retainedEventLives.length,
        fixtureCount: retainedFixtures.length,
        fixtureTeamCount: fixtureTeamCount(retainedFixtures),
        bonusTeamCount: bonusTeamCount(),
        persistedFixtures,
        persistedEventLives,
      };
    }
    if (!staging || !canonical) {
      throw new DatabaseError('Advanced live snapshot has no canonical publication proof');
    }
    dbActivated = true;
    const sourceAgeMs = Math.max(0, Date.now() - lastSuccessfulFetchAt.getTime());
    if (sourceAgeMs > LIVE_SOURCE_STALE_AFTER_MS) {
      logError(
        'Live snapshot source exceeded hard freshness threshold',
        new Error('LIVE_SOURCE_STALE'),
        {
          eventId,
          sourceCheckedAt: checkedAt.toISOString(),
          lastSuccessfulFetchAt: lastSuccessfulFetchAt.toISOString(),
          sourceAgeMs,
          thresholdMs: LIVE_SOURCE_STALE_AFTER_MS,
        },
      );
    }
    const delivered = await dispatchDataPublicationOutbox({
      limit: 1,
      publicationId: staging.publicationId,
    });
    if (delivered.delivered !== 1) {
      const deliveredActive = await dependencies.readPublished(season.seasonCode, eventId);
      if (
        deliveredActive?.manifest.publicationId !== staging.publicationId ||
        deliveredActive.manifest.revision !== staging.revision
      ) {
        throw new Error(
          `Live publication ${staging.publicationId} is canonical but Redis delivery is pending`,
        );
      }
    }

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
      lastSuccessfulFetchAt: lastSuccessfulFetchAt.toISOString(),
      sourceAgeMs,
      stale: sourceAgeMs > LIVE_SOURCE_STALE_AFTER_MS,
    });
    return result;
  } catch (error) {
    if (!dbActivated) {
      await syncOperationsRepository.failRun(sourceRunId, error).catch(() => undefined);
    }
    throw error;
  }
}

export function liveEventRowsFromSnapshot(snapshot: LiveSnapshotCacheContents): EventLive[] {
  return [...snapshot.eventLives];
}
