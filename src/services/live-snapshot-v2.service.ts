import { fplClient } from '../clients/fpl';
import type { FplSeasonRef } from '../domain/fpl-season';
import { LIVE_SCORE_CHECKPOINT_INTERVAL_MS } from '../domain/job-schedules';
import type { RawFPLEventLiveResponse, RawFPLFixture } from '../types';
import type { EventLive } from '../domain/event-lives';
import {
  markLivePublicationCheckpointedV2,
  publishLivePublicationV2,
  readLivePublicationV2,
  restoreLivePublicationV2Checkpoint,
  clearLiveCheckpointDesiredV2,
  readLiveCheckpointDesiredV2,
  setLiveCheckpointDesiredV2,
  touchLivePublicationV2,
  type LivePublicationRead,
  type LivePublicationState,
} from '../cache/live-publication-v2';
import {
  readLiveMatchDeskFenceV3,
  readLiveMatchDetailFenceV3,
  restoreLiveMatchEquivalentFinalPairV3,
  setLiveMatchActiveEventV3,
  type MatchDeskActiveFence,
  type MatchDetailActiveFence,
} from '../cache/live-match-publication-v3';
import {
  loadLiveReferenceData,
  prepareCoherentLiveSnapshot,
  resolveLiveReferenceDataForDetail,
  type LiveSnapshotReferenceData,
  type PreparedLiveSnapshot,
} from './live-coherent-fetch';
import {
  checkpointLivePublicationV2,
  readLivePublicationV2Checkpoint,
} from './live-publication-v2-checkpoint.service';
import {
  syncLiveMatchesV3FromObservation,
  type LiveMatchObservationResult,
} from './live-match-v3.service';
import {
  hasFinalLiveMatchCheckpointsV3,
  readFinalLiveMatchCheckpointPairV3,
  readLiveMatchFinalCheckpointIdentitiesV3,
  type LiveMatchCheckpointIdentities,
  type FinalLiveMatchCheckpointPair,
} from './live-match-v3-checkpoint.service';
import {
  prepareLiveMatchDesk,
  prepareLiveMatchDetail,
  type MatchDeskFixture,
  type MatchLifecycleState,
} from './live-match-v3';
import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import { logError, logInfo } from '../utils/logger';
import { canonicalJson } from '../utils/content-hash';
import { CacheError } from '../utils/errors';
import type { DbOrTransaction } from '../db/singleton';
import {
  createLiveSnapshotDatabaseBudget,
  type LiveSnapshotDatabaseBudget,
} from '../utils/live-snapshot-db-budget';
import type { SchedulerLanePublicationFence } from '../repositories/scheduler-lanes';

/**
 * Run a Redis publication activation while the caller holds its durable
 * latest-authoritative lane fence. The generic callback keeps the cache
 * service independent of scheduler transactions while allowing the worker to
 * hold its row lock across the activation command.
 */
export type LiveSnapshotPublicationActivation = <T>(activate: () => Promise<T>) => Promise<T>;

export interface LiveSnapshotV2SyncOptions {
  /**
   * A caller that already completed the coherent fixtures observation may pass
   * it through so finalization is decided from the same response that is
   * consumed by the sync. This is intentionally an observation value, not a
   * cache or a second source of truth.
   */
  readonly observedFixtures?: readonly RawFPLFixture[];
  readonly finalizeEvent?: boolean;
  readonly lifecycleState?: MatchLifecycleState;
  readonly trigger?: 'cron' | 'manual' | 'cascade' | 'catchup' | 'reconcile';
  readonly sourceRunId?: string;
  readonly expectedNextCheckAt?: Date | string | null;
  readonly dependencies?: LiveSnapshotV2Dependencies;
  /** Worker-owned local database budget; omitted by hermetic unit callers. */
  readonly databaseBudget?: LiveSnapshotDatabaseBudget;
  /** Exact latest-authoritative lane identity for durable checkpoints. */
  readonly schedulerLaneFence?: SchedulerLanePublicationFence;
  /** Hold the lane fence through the Redis publication activation command. */
  readonly withPublicationActivationFence?: LiveSnapshotPublicationActivation;
}

export interface LiveSnapshotV2Dependencies {
  readonly getEventLive: (eventId: number) => ReturnType<typeof fplClient.getEventLive>;
  readonly getFixtures: (eventId: number) => ReturnType<typeof fplClient.getFixtures>;
  readonly getExpectedFixtureIds: (
    season: FplSeasonRef,
    eventId: number,
  ) => Promise<readonly number[]>;
  readonly getReferenceData: (
    season: FplSeasonRef,
    eventId: number,
    dbInstance?: DbOrTransaction,
  ) => Promise<LiveSnapshotReferenceData>;
  readonly readObservedMatchDesk?: typeof readLiveMatchDeskFenceV3;
  readonly readObservedMatchDetail?: typeof readLiveMatchDetailFenceV3;
  readonly syncLiveMatches?: typeof syncLiveMatchesV3FromObservation;
  /** Test/repair seam for the Redis restore; production uses the V2 helper. */
  readonly restoreLivePublicationCheckpoint?: typeof restoreLivePublicationV2Checkpoint;
  readonly readPublished: (season: string, eventId: number) => Promise<LivePublicationRead | null>;
  readonly readCheckpointed?: (
    season: FplSeasonRef,
    eventId: number,
    dbInstance?: DbOrTransaction,
  ) => Promise<LivePublicationRead | null>;
  readonly readCheckpointDesired?: typeof readLiveCheckpointDesiredV2;
  readonly clearCheckpointDesired?: typeof clearLiveCheckpointDesiredV2;
  readonly readFinalMatchCheckpoints?: typeof readFinalLiveMatchCheckpointPairV3;
  readonly readMatchCheckpointIdentities?: typeof readLiveMatchFinalCheckpointIdentitiesV3;
  readonly setActiveMatchEvent?: typeof setLiveMatchActiveEventV3;
  readonly restoreFinalMatchPair?: typeof restoreLiveMatchEquivalentFinalPairV3;
  readonly hasFinalMatchCheckpoints?: typeof hasFinalLiveMatchCheckpointsV3;
  readonly checkpointPublication: (request: {
    readonly season: FplSeasonRef;
    readonly eventId: number;
    readonly publication: LivePublicationRead['publication'];
    readonly eventLives: ReadonlyArray<PreparedLiveSnapshot['eventLives']['eventLives'][number]>;
    readonly fixtures: ReadonlyArray<PreparedLiveSnapshot['fixtures'][number]>;
    readonly explains: ReadonlyArray<PreparedLiveSnapshot['eventLives']['explains'][number]>;
    readonly fixtureEvidence: ReadonlyArray<
      PreparedLiveSnapshot['eventLives']['fixtureEvidence'][number]
    >;
    readonly observationCheckedAt?: Date | string;
    readonly db?: DbOrTransaction;
  }) => Promise<boolean>;
}

export interface LiveSnapshotV2SyncResult {
  readonly eventId: number;
  readonly changed: boolean;
  readonly stale: boolean;
  readonly published: boolean;
  readonly generation: number | null;
  readonly publicationId: string | null;
  /** Source-check timestamp of the exact publication returned by this call. */
  readonly sourceCheckedAt: string | null;
  readonly state: LivePublicationState;
  readonly eventLiveCount: number;
  readonly fixtureCount: number;
  readonly checkpointScheduled: boolean;
  readonly checkpointed: boolean;
  /** Match desk/detail checkpoint creation failed after the Redis publication. */
  readonly checkpointObligationFailed: boolean;
  /** Bounded stage timings used to distinguish queue, provider, Redis and DB delay. */
  readonly stageTimings: LiveSnapshotStageTimings;
}

export type LiveSnapshotStageTimings = Readonly<{
  /** Durable PostgreSQL control/checkpoint read. */
  controlReadMs: number | null;
  /** Serving Redis current-publication read. */
  redisReadMs: number | null;
  /** Durable PostgreSQL checkpoint read, retained as a separate stage. */
  durableReadMs: number | null;
  /** Core/reference identity read, which may use Redis or PostgreSQL fallback. */
  referenceReadMs: number | null;
  /** Fixture identity baseline read, normally from the Core Redis publication. */
  fixtureIdentityReadMs: number | null;
  providerMs: number | null;
  redisPublishMs: number | null;
  checkpointMs: number | null;
  totalMs: number;
}>;

const defaultDependencies: LiveSnapshotV2Dependencies = {
  getEventLive: (eventId) => fplClient.getEventLive(eventId),
  getFixtures: (eventId) => fplClient.getFixtures(eventId),
  getExpectedFixtureIds: async (season, eventId) => {
    const core = await readCoreSnapshotCache(season.seasonCode);
    if (!core) {
      throw new Error(`Core publication fixture identity is unavailable for live event ${eventId}`);
    }
    return core.fixtures
      .filter((fixture) => fixture.event === eventId)
      .map((fixture) => fixture.id);
  },
  readObservedMatchDesk: (input) => readLiveMatchDeskFenceV3(input),
  readObservedMatchDetail: (input) => readLiveMatchDetailFenceV3(input),
  getReferenceData: (season, eventId, dbInstance) =>
    loadLiveReferenceData(season, eventId, dbInstance),
  syncLiveMatches: syncLiveMatchesV3FromObservation,
  readPublished: (season, eventId) => readLivePublicationV2({ season, eventId }),
  readCheckpointed: (season, eventId, dbInstance) =>
    readLivePublicationV2Checkpoint(season, eventId, dbInstance),
  readFinalMatchCheckpoints: readFinalLiveMatchCheckpointPairV3,
  readMatchCheckpointIdentities: readLiveMatchFinalCheckpointIdentitiesV3,
  setActiveMatchEvent: setLiveMatchActiveEventV3,
  checkpointPublication: checkpointLivePublicationV2,
};

function publicationState(
  prepared: PreparedLiveSnapshot,
  finalized: boolean,
): LivePublicationState {
  if (finalized) return 'FINALIZED';
  if (prepared.state === 'live') return 'LIVE_ACTIVE';
  if (prepared.state === 'settled') return 'DAY_SETTLING';
  return 'PRE_DEADLINE';
}

function samePayload(
  left: LivePublicationRead | null,
  prepared: PreparedLiveSnapshot,
  state: LivePublicationState,
): boolean {
  return Boolean(
    left &&
      left.publication.state === state &&
      canonicalJson(left.eventLives) === canonicalJson(prepared.eventLives.eventLives) &&
      canonicalJson(left.fixtures) === canonicalJson(prepared.fixtures),
  );
}

/**
 * A FINAL publication is reusable only when the serving pointer and the
 * durable checkpoint identify the same immutable payload.  The checkpoint
 * reader validates the PostgreSQL manifest/hash/count proof; comparing the
 * materialized arrays here closes the remaining Redis-vs-PostgreSQL identity
 * gap without starting another provider observation.
 */
function isCompleteFinalPublication(
  current: LivePublicationRead | null,
  durable: LivePublicationRead | null,
  season: FplSeasonRef,
  eventId: number,
): boolean {
  return Boolean(
    current?.servedFrom === 'REDIS_CURRENT' &&
      durable?.servedFrom === 'POSTGRES_CHECKPOINT' &&
      current.publication.season === season.seasonCode &&
      current.publication.eventId === eventId &&
      durable.publication.season === season.seasonCode &&
      durable.publication.eventId === eventId &&
      current.publication.state === 'FINALIZED' &&
      durable.publication.state === 'FINALIZED' &&
      current.publication.publicationId === durable.publication.publicationId &&
      current.publication.generation === durable.publication.generation &&
      current.publication.checkpointedAt !== null &&
      durable.publication.checkpointedAt !== null &&
      canonicalJson(current.eventLives) === canonicalJson(durable.eventLives) &&
      canonicalJson(current.fixtures) === canonicalJson(durable.fixtures),
  );
}

function isDurableFinalPublication(
  durable: LivePublicationRead | null,
  season: FplSeasonRef,
  eventId: number,
): boolean {
  return Boolean(
    durable?.servedFrom === 'POSTGRES_CHECKPOINT' &&
      durable.publication.season === season.seasonCode &&
      durable.publication.eventId === eventId &&
      durable.publication.state === 'FINALIZED' &&
      durable.publication.checkpointedAt !== null,
  );
}

function shouldCheckpoint(
  current: LivePublicationRead | null,
  state: LivePublicationState,
  finalizeEvent: boolean,
  promoted: LivePublicationRead['publication'],
  desiredRequestedAt: string | null = null,
): boolean {
  if (finalizeEvent || !current) return true;
  if (current.publication.state !== state) return true;
  // Fixture identity and display-only changes are cheap, semantically useful
  // checkpoints.  A display revision normally moves with score core (minutes,
  // points, and starts), so it must not bypass the ten-minute score checkpoint
  // coalescing window.  Only a display-only revision can checkpoint immediately.
  const fixtureIdentityChanged =
    current.publication.revisions.fixtureIdentity.revision !==
    promoted.revisions.fixtureIdentity.revision;
  const scoreCoreChanged =
    current.publication.revisions.scoreCore.revision !== promoted.revisions.scoreCore.revision;
  const displayStatsChanged =
    current.publication.revisions.displayStats.revision !==
    promoted.revisions.displayStats.revision;
  if (fixtureIdentityChanged || (displayStatsChanged && !scoreCoreChanged)) return true;
  // A missing checkpoint is an outstanding durability obligation. The first
  // obligation is repaired immediately, but a deliberately coalesced score
  // generation must honor its recent desired-request timestamp rather than
  // writing again on the very next unchanged heartbeat.
  if (!current.publication.checkpointedAt) {
    if (desiredRequestedAt !== null) {
      const requestedAt = Date.parse(desiredRequestedAt);
      if (Number.isFinite(requestedAt)) {
        return Date.now() - requestedAt >= LIVE_SCORE_CHECKPOINT_INTERVAL_MS;
      }
    }
    return true;
  }
  if (desiredRequestedAt !== null) {
    const requestedAt = Date.parse(desiredRequestedAt);
    if (Number.isFinite(requestedAt)) {
      return Date.now() - requestedAt >= LIVE_SCORE_CHECKPOINT_INTERVAL_MS;
    }
  }
  const checkpointedAt = Date.parse(current.publication.checkpointedAt);
  return (
    !Number.isFinite(checkpointedAt) ||
    Date.now() - checkpointedAt >= LIVE_SCORE_CHECKPOINT_INTERVAL_MS
  );
}

async function checkpoint(
  dependencies: LiveSnapshotV2Dependencies,
  season: FplSeasonRef,
  eventId: number,
  payload: {
    readonly eventLives: ReadonlyArray<PreparedLiveSnapshot['eventLives']['eventLives'][number]>;
    readonly fixtures: ReadonlyArray<PreparedLiveSnapshot['fixtures'][number]>;
    readonly explains: ReadonlyArray<PreparedLiveSnapshot['eventLives']['explains'][number]>;
    readonly fixtureEvidence: ReadonlyArray<
      PreparedLiveSnapshot['eventLives']['fixtureEvidence'][number]
    >;
  },
  publication: LivePublicationRead['publication'],
  desired: Awaited<ReturnType<typeof setLiveCheckpointDesiredV2>> | null,
  observationCheckedAt?: Date | string,
  databaseBudget?: LiveSnapshotDatabaseBudget | null,
  schedulerLaneFence?: SchedulerLanePublicationFence,
): Promise<boolean> {
  try {
    const checkpointed = await dependencies.checkpointPublication({
      season,
      eventId,
      publication,
      eventLives: payload.eventLives,
      fixtures: payload.fixtures,
      explains: payload.explains,
      fixtureEvidence: payload.fixtureEvidence,
      observationCheckedAt,
      ...(databaseBudget ? { db: databaseBudget.writeDb } : {}),
      ...(schedulerLaneFence ? { schedulerLaneFence } : {}),
    });
    if (!checkpointed) return false;
    const marked = await markLivePublicationCheckpointedV2(publication, new Date());
    if (marked === null) return false;
    if (desired) await clearLiveCheckpointDesiredV2(desired);
    return true;
  } catch (error) {
    // Redis remains the serving authority. The next live poll reconciles the
    // latest current publication; this keeps one desired checkpoint per scope
    // instead of stacking a new DB job every 30 seconds.
    logError('Live Points V2 checkpoint failed; keeping Redis current', error, {
      season: season.seasonCode,
      eventId,
      publicationId: publication.publicationId,
      generation: publication.generation,
    });
    return false;
  }
}

type LiveCheckpointDesired = Awaited<ReturnType<typeof setLiveCheckpointDesiredV2>>;

type AcceptedMatchObservation = Readonly<{
  rawEventLive: RawFPLEventLiveResponse;
  rawFixtures: readonly RawFPLFixture[];
  referenceData: LiveSnapshotReferenceData;
  expectedFixtureIds: readonly number[];
}>;

async function publishedDeskFromMatchResult(
  result: LiveMatchObservationResult,
  readObservedMatchDesk?: typeof readLiveMatchDeskFenceV3,
): Promise<NonNullable<Parameters<typeof syncLiveMatchesV3FromObservation>[0]['publishedDesk']>> {
  const observedActive: MatchDeskActiveFence = readObservedMatchDesk
    ? await readObservedMatchDesk({ season: result.season, eventId: result.eventId })
    : {
        // Test-only direct callers may not provide the production Redis fence
        // dependency. The production scheduler always does, so finalization
        // uses the exact active-pointer bytes returned by Redis below.
        observed: JSON.stringify(result.desk),
        read: {
          publication: result.desk,
          fixtures: result.deskFixtures,
          servedFrom: 'REDIS_CURRENT',
        },
      };
  if (
    observedActive.read?.publication?.publicationId !== result.desk?.publicationId ||
    observedActive.read?.publication?.generation !== result.desk?.generation
  ) {
    throw new CacheError(
      `Live Match provisional desk changed before finalization for event ${result.eventId}`,
      'LIVE_MATCH_PROMOTE_CHANGED',
    );
  }
  return {
    publication: result.desk,
    fixtures: result.deskFixtures,
    changed: result.deskChanged,
    checkpointScheduled: result.deskCheckpointScheduled,
    checkpointObligationFailed: result.checkpointObligationFailed,
    observedActive,
  };
}

async function detailFenceForFinalization(
  result: LiveMatchObservationResult,
  readObservedMatchDetail?: typeof readLiveMatchDetailFenceV3,
): Promise<MatchDetailActiveFence | undefined> {
  if (!readObservedMatchDetail) return undefined;
  const observed = await readObservedMatchDetail({
    season: result.season,
    eventId: result.eventId,
  });
  if (
    result.detail &&
    (observed.read?.publication?.publicationId !== result.detail.publicationId ||
      observed.read?.publication?.generation !== result.detail.generation)
  ) {
    throw new CacheError(
      `Live Match provisional detail changed before finalization for event ${result.eventId}`,
      'LIVE_MATCH_PROMOTE_CHANGED',
    );
  }
  return observed;
}

/**
 * A durable Match FINAL is not enough for consumers: both active Redis
 * pointers must still expose the same validated final pair. The checkpoint
 * probe proves PostgreSQL durability; this serving probe proves the current
 * read model was not lost or corrupted after that checkpoint.
 */
function isServingFinalMatchPair(
  deskFence: MatchDeskActiveFence | undefined,
  detailFence: MatchDetailActiveFence | undefined,
  season: FplSeasonRef,
  eventId: number,
  expectedPair?: FinalLiveMatchCheckpointPair | null,
): boolean {
  const desk = deskFence?.read;
  const detail = detailFence?.read;
  const canonicalIdentityMatches =
    expectedPair == null ||
    (desk?.publication.publicationId === expectedPair?.desk.publication.publicationId &&
      desk?.publication.generation === expectedPair?.desk.publication.generation &&
      detail?.publication.publicationId === expectedPair?.detail.publication.publicationId &&
      detail?.publication.generation === expectedPair?.detail.publication.generation);
  return Boolean(
    desk?.servedFrom === 'REDIS_CURRENT' &&
      detail?.servedFrom === 'REDIS_CURRENT' &&
      desk.publication.season === season.seasonCode &&
      desk.publication.eventId === eventId &&
      detail.publication.season === season.seasonCode &&
      detail.publication.eventId === eventId &&
      desk.publication.state === 'FINALIZED' &&
      desk.publication.checkpointedAt !== null &&
      detail.publication.finalized === true &&
      detail.publication.checkpointedAt !== null &&
      detail.publication.observedDeskGeneration === desk.publication.generation &&
      detail.publication.fixtureIdentityRevision ===
        desk.publication.revisions.fixtureIdentity.revision &&
      canonicalIdentityMatches,
  );
}

type MatchPlayerFacts = Readonly<{
  totalPoints: number;
  stats: ReadonlyMap<string, Readonly<{ value: number; awardedPoints: number }>>;
}>;

type MatchDetailFacts = ReadonlyMap<number, ReadonlyMap<number, MatchPlayerFacts>>;

function matchStatAwardedPoints(stat: {
  readonly points: number;
  readonly pointsModification: number | null;
}): number {
  return stat.points + (stat.pointsModification ?? 0);
}

function matchDetailFactsFromLiveFinal(final: LivePublicationRead): MatchDetailFacts | null {
  const byFixture = new Map<
    number,
    Map<
      number,
      { totalPoints: number; stats: Map<string, { value: number; awardedPoints: number }> }
    >
  >();
  for (const row of final.eventLives as readonly EventLive[]) {
    if (!row.fixtureBreakdown) return null;
    let rowTotalPoints = 0;
    for (const breakdown of row.fixtureBreakdown) {
      let players = byFixture.get(breakdown.fixtureId);
      if (!players) {
        players = new Map();
        byFixture.set(breakdown.fixtureId, players);
      }
      const stats = new Map<string, { value: number; awardedPoints: number }>(
        breakdown.stats.map((stat): [string, { value: number; awardedPoints: number }] => [
          stat.identifier,
          {
            value: stat.value,
            awardedPoints: matchStatAwardedPoints(stat),
          },
        ]),
      );
      const totalPoints = [...stats.values()].reduce((sum, stat) => sum + stat.awardedPoints, 0);
      rowTotalPoints += totalPoints;
      players.set(row.elementId, { totalPoints, stats });
    }
    if (rowTotalPoints !== row.totalPoints) return null;
  }
  for (const fixture of final.fixtures) {
    const bps = fixture.stats.find((stat) => stat.identifier === 'bps');
    if (!bps) continue;
    let players = byFixture.get(fixture.id);
    if (!players) {
      players = new Map();
      byFixture.set(fixture.id, players);
    }
    for (const bpsRow of [...bps.h, ...bps.a]) {
      const existing = players.get(bpsRow.element);
      if (existing) {
        if (!existing.stats.has('bps')) {
          existing.stats.set('bps', { value: bpsRow.value, awardedPoints: 0 });
        }
      } else {
        players.set(bpsRow.element, {
          totalPoints: 0,
          stats: new Map([['bps', { value: bpsRow.value, awardedPoints: 0 }]]),
        });
      }
    }
  }
  for (const [fixtureId, players] of byFixture) {
    for (const [playerId, player] of players) {
      const visible = [...player.stats.values()].some(
        (stat) => stat.value !== 0 || stat.awardedPoints !== 0,
      );
      if (!visible) players.delete(playerId);
    }
    if (players.size === 0) byFixture.delete(fixtureId);
  }
  return byFixture;
}

function matchPlayerFactsEqual(left: MatchPlayerFacts, right: MatchPlayerFacts): boolean {
  if (left.totalPoints !== right.totalPoints || left.stats.size !== right.stats.size) return false;
  for (const [identifier, stat] of left.stats) {
    const candidate = right.stats.get(identifier);
    if (
      !candidate ||
      candidate.value !== stat.value ||
      candidate.awardedPoints !== stat.awardedPoints
    ) {
      return false;
    }
  }
  return true;
}

type MatchDeskFactsRead = Pick<FinalLiveMatchCheckpointPair['desk'], 'fixtures'>;
type MatchDetailFactsRead = Pick<FinalLiveMatchCheckpointPair['detail'], 'fixtures'>;

function durableMatchDeskFactsAgreeWithLiveFinal(
  desk: MatchDeskFactsRead,
  final: LivePublicationRead,
): boolean {
  const finalFixtures = new Map(final.fixtures.map((fixture) => [fixture.id, fixture]));
  if (
    finalFixtures.size !== final.fixtures.length ||
    desk.fixtures.length !== final.fixtures.length
  )
    return false;
  for (const fixture of desk.fixtures as readonly MatchDeskFixture[]) {
    const source = finalFixtures.get(fixture.fixtureId);
    if (
      !source ||
      fixture.eventId !== (source.event ?? fixture.eventId) ||
      fixture.homeTeamId !== source.teamH ||
      fixture.awayTeamId !== source.teamA ||
      fixture.homeScore !== source.teamHScore ||
      fixture.awayScore !== source.teamAScore ||
      fixture.kickoffTime !== (source.kickoffTime?.toISOString() ?? null) ||
      fixture.minutes !== source.minutes ||
      fixture.started !== (source.started === true) ||
      fixture.finished !== source.finished ||
      fixture.finishedProvisional !== source.finishedProvisional
    ) {
      return false;
    }
  }
  return true;
}

function durableMatchDetailFactsAgreeWithLiveFinal(
  detail: MatchDetailFactsRead,
  final: LivePublicationRead,
): boolean | null {
  const expectedDetail = matchDetailFactsFromLiveFinal(final);
  // Older durable Live Points FINALs may legitimately omit fixture-level
  // explain breakdowns. That is unavailable comparison evidence, not a facts
  // contradiction; callers must use the desk/identity proof or fetch a fresh
  // compatible observation instead of rejecting the retained FINAL.
  if (!expectedDetail) return null;
  const actualDetail = new Map(
    detail.fixtures.map((fixture) => [
      fixture.fixtureId,
      new Map(
        fixture.players.map((player) => [
          player.id,
          {
            totalPoints: player.totalPoints,
            stats: new Map(
              player.stats.map((stat) => [
                stat.identifier,
                { value: stat.value, awardedPoints: stat.awardedPoints },
              ]),
            ),
          },
        ]),
      ),
    ]),
  );
  const expectedFixtureIds = new Set(final.fixtures.map((fixture) => fixture.id));
  const actualFixtureIds = new Set(detail.fixtures.map((fixture) => fixture.fixtureId));
  if (
    actualFixtureIds.size !== detail.fixtures.length ||
    actualFixtureIds.size !== expectedFixtureIds.size
  )
    return false;
  for (const fixtureId of expectedFixtureIds) {
    if (!actualFixtureIds.has(fixtureId)) return false;
  }
  for (const [fixtureId, expectedPlayers] of expectedDetail) {
    const actualPlayers = actualDetail.get(fixtureId);
    if (!actualPlayers || actualPlayers.size !== expectedPlayers.size) return false;
    for (const [playerId, expected] of expectedPlayers) {
      const actual = actualPlayers.get(playerId);
      if (!actual || !matchPlayerFactsEqual(expected, actual)) return false;
    }
  }
  for (const [fixtureId, actualPlayers] of actualDetail) {
    if (!expectedDetail.has(fixtureId) && actualPlayers.size > 0) return false;
  }
  return true;
}

/** Compare the overlapping canonical facts before accepting a durable Match FINAL. */
function durableMatchFactsAgreeWithLiveFinal(
  pair: Pick<FinalLiveMatchCheckpointPair, 'desk' | 'detail'>,
  final: LivePublicationRead,
): boolean | null {
  if (!durableMatchDeskFactsAgreeWithLiveFinal(pair.desk, final)) return false;
  const detailFactsAgree = durableMatchDetailFactsAgreeWithLiveFinal(pair.detail, final);
  return detailFactsAgree === false ? false : detailFactsAgree;
}

/**
 * A Redis FINAL without a durable row is a recovery obligation, not a reason
 * to checkpoint the two Redis payloads on their own.  Keep one merged desired
 * marker while the coherent upstream read below reconstructs the relational
 * explain and fixture-evidence facts as well.
 */
async function ensureFinalRecoveryDesired(
  season: FplSeasonRef,
  eventId: number,
  publication: LivePublicationRead['publication'],
): Promise<LiveCheckpointDesired | null> {
  let desired: LiveCheckpointDesired | null = null;
  try {
    desired = await readLiveCheckpointDesiredV2({
      season: season.seasonCode,
      eventId,
    });
  } catch (error) {
    logError('Live Points V2 final recovery obligation read failed', error, {
      season: season.seasonCode,
      eventId,
      publicationId: publication.publicationId,
      generation: publication.generation,
    });
  }
  if (desired !== null) return desired;
  try {
    return await setLiveCheckpointDesiredV2(publication);
  } catch (error) {
    logError('Live Points V2 final recovery obligation write failed', error, {
      season: season.seasonCode,
      eventId,
      publicationId: publication.publicationId,
      generation: publication.generation,
    });
    return null;
  }
}

export async function syncLiveSnapshotV2(
  season: FplSeasonRef,
  eventId: number,
  options: LiveSnapshotV2SyncOptions = {},
): Promise<LiveSnapshotV2SyncResult> {
  if (!Number.isSafeInteger(eventId) || eventId <= 0)
    throw new Error(`Invalid live event ID: ${eventId}`);
  const totalStartedAt = Date.now();
  let controlReadMs: number | null = null;
  let redisReadMs: number | null = null;
  let durableReadMs: number | null = null;
  let referenceReadMs: number | null = null;
  let fixtureIdentityReadMs: number | null = null;
  let providerMs: number | null = null;
  let redisPublishMs: number | null = null;
  let checkpointMs: number | null = null;
  const stageTimings = (): LiveSnapshotStageTimings => ({
    controlReadMs,
    redisReadMs,
    durableReadMs,
    referenceReadMs,
    fixtureIdentityReadMs,
    providerMs,
    redisPublishMs,
    checkpointMs,
    totalMs: Math.max(0, Date.now() - totalStartedAt),
  });
  const dependencies = options.dependencies ?? defaultDependencies;
  const activatePublication: LiveSnapshotPublicationActivation =
    options.withPublicationActivationFence ?? (async <T>(activate: () => Promise<T>) => activate());
  const databaseBudget =
    options.databaseBudget ??
    (dependencies === defaultDependencies
      ? await createLiveSnapshotDatabaseBudget().catch((error) => {
          logError('Live snapshot database budget initialization failed', error, {
            season: season.seasonCode,
            eventId,
          });
          throw error;
        })
      : null);
  // Redis is the serving authority, but a rebuilt Redis sequence must not be
  // allowed to fence an older durable checkpoint forever. Start that durable
  // read in parallel; it must never delay the shared provider observation used
  // by the independent Live Matches Redis publication.
  const durableReadStartedAt = Date.now();
  const durableReadPromise = (dependencies.readCheckpointed ?? readLivePublicationV2Checkpoint)(
    season,
    eventId,
    databaseBudget?.readDb,
  )
    .then((value) => ({ value, failed: false as const }))
    .catch((error) => {
      logError('Live Points V2 durable checkpoint read failed', error, {
        season: season.seasonCode,
        eventId,
      });
      return { value: null, failed: true as const };
    })
    .finally(() => {
      durableReadMs = Math.max(0, Date.now() - durableReadStartedAt);
    });
  const currentReadStartedAt = Date.now();
  let currentReadMs: number | null = null;
  const currentReadPromise = dependencies
    .readPublished(season.seasonCode, eventId)
    .catch((error) => {
      // A Redis read outage must not prevent a durable FINAL checkpoint from
      // repairing the serving pointer before any upstream fetch is attempted.
      logError('Live Points V2 current publication read failed', error, {
        season: season.seasonCode,
        eventId,
      });
      return null;
    });
  const current = await currentReadPromise;
  currentReadMs = Math.max(0, Date.now() - currentReadStartedAt);
  redisReadMs = currentReadMs;
  const readFinalMatchCheckpoints = dependencies.readFinalMatchCheckpoints;
  const hasFinalMatchCheckpoints =
    dependencies.hasFinalMatchCheckpoints ?? hasFinalLiveMatchCheckpointsV3;
  const repairMatchForReusedFinal = async (durableFinal: LivePublicationRead): Promise<void> => {
    let matchFinalized = false;
    let durableMatchPair: FinalLiveMatchCheckpointPair | null = null;
    let expectedFinalCheckpointIdentities: LiveMatchCheckpointIdentities | undefined;
    try {
      if (readFinalMatchCheckpoints) {
        durableMatchPair = await readFinalMatchCheckpoints(season, eventId, databaseBudget?.readDb);
        matchFinalized = durableMatchPair !== null;
      } else {
        // Keep the boolean seam for older hermetic callers; production uses
        // the identity-bearing reader above so Redis cannot satisfy a
        // different finalized generation.
        matchFinalized = await hasFinalMatchCheckpoints(season, eventId, databaseBudget?.readDb);
      }
    } catch (error) {
      logError('Live Match FINAL checkpoint probe failed during Live Points reuse', error, {
        season: season.seasonCode,
        eventId,
      });
      // A failed durable probe is not evidence that the Match checkpoints are
      // absent.  Treating it as absence would send a duplicate provider
      // request and could overwrite an otherwise recoverable FINAL.  Surface a
      // bounded cache error so the scheduler can retry the obligation.
      throw new CacheError(
        `Live Match FINAL checkpoints unavailable for event ${eventId}`,
        'LIVE_MATCH_FINAL_CHECKPOINT_PROBE_FAILED',
        error instanceof Error ? error : undefined,
      );
    }

    if (durableMatchPair) {
      expectedFinalCheckpointIdentities = {
        desk: {
          publicationId: durableMatchPair.desk.publication.publicationId,
          generation: durableMatchPair.desk.publication.generation,
        },
        detail: {
          publicationId: durableMatchPair.detail.publication.publicationId,
          generation: durableMatchPair.detail.publication.generation,
        },
      };
    } else if (dependencies.readMatchCheckpointIdentities) {
      try {
        expectedFinalCheckpointIdentities = await dependencies.readMatchCheckpointIdentities(
          season,
          eventId,
          databaseBudget?.readDb,
        );
      } catch (error) {
        logError('Live Match FINAL identity probe failed during Live Points reuse', error, {
          season: season.seasonCode,
          eventId,
        });
        throw new CacheError(
          `Live Match FINAL identities unavailable for event ${eventId}`,
          'LIVE_MATCH_FINAL_CHECKPOINT_PROBE_FAILED',
          error instanceof Error ? error : undefined,
        );
      }
    }

    if (
      durableMatchPair &&
      durableMatchFactsAgreeWithLiveFinal(durableMatchPair, durableFinal) === false
    ) {
      throw new CacheError(
        `Live Match durable FINAL conflicts with Live Points facts for event ${eventId}`,
        'LIVE_MATCH_FINAL_FACTS_MISMATCH',
      );
    }

    // Production dependencies expose both active-pointer readers. A custom
    // hermetic caller may omit them; its durable checkpoint seam remains the
    // only available serving proof and keeps the existing unit contract.
    let observedMatchDesk: MatchDeskActiveFence | undefined;
    let observedMatchDetail: MatchDetailActiveFence | undefined;
    const canProbeServingPair =
      dependencies.readObservedMatchDesk !== undefined &&
      dependencies.readObservedMatchDetail !== undefined;
    if (canProbeServingPair) {
      try {
        [observedMatchDesk, observedMatchDetail] = await Promise.all([
          dependencies.readObservedMatchDesk!({
            season: season.seasonCode,
            eventId,
          }),
          dependencies.readObservedMatchDetail!({
            season: season.seasonCode,
            eventId,
          }),
        ]);
      } catch (error) {
        logError('Live Match serving FINAL probe failed during Live Points reuse', error, {
          season: season.seasonCode,
          eventId,
        });
        // Retry the two active pointers before any provider/support request is
        // created. A missing fence is unsafe for recovery, so a second read
        // failure remains a bounded cache error and the scheduler retries.
        try {
          [observedMatchDesk, observedMatchDetail] = await Promise.all([
            dependencies.readObservedMatchDesk!({
              season: season.seasonCode,
              eventId,
            }),
            dependencies.readObservedMatchDetail!({
              season: season.seasonCode,
              eventId,
            }),
          ]);
        } catch (retryError) {
          throw new CacheError(
            `Live Match serving fence unavailable for event ${eventId}`,
            'LIVE_MATCH_SERVING_FENCE_UNAVAILABLE',
            retryError instanceof Error ? retryError : undefined,
          );
        }
      }
      if (
        matchFinalized &&
        isServingFinalMatchPair(
          observedMatchDesk,
          observedMatchDetail,
          season,
          eventId,
          durableMatchPair,
        )
      ) {
        await dependencies.setActiveMatchEvent?.({
          season: season.seasonCode,
          eventId,
        });
        return;
      }
    } else if (matchFinalized) {
      return;
    }

    const observedDeskRead = observedMatchDesk?.read;
    const observedDetailRead = observedMatchDetail?.read;
    if (canProbeServingPair) {
      // Every surviving FINAL sibling is an untrusted recovery candidate until
      // its own facts agree with the durable Live Points FINAL. Validate these
      // siblings before invoking the synchronizer: that call creates forced
      // checkpoint markers and would otherwise leave side effects behind when
      // a later pair-level facts check rejects the Redis candidate.
      const observedDeskIsFinal = observedDeskRead?.publication.state === 'FINALIZED';
      const observedDetailIsFinal = observedDetailRead?.publication.finalized === true;
      if (
        observedDeskIsFinal &&
        !durableMatchDeskFactsAgreeWithLiveFinal(observedDeskRead!, durableFinal)
      ) {
        throw new CacheError(
          `Live Match Redis FINAL conflicts with durable facts for event ${eventId}`,
          'LIVE_MATCH_FINAL_REDIS_CONFLICT',
        );
      }
      if (
        observedDetailIsFinal &&
        durableMatchDetailFactsAgreeWithLiveFinal(observedDetailRead!, durableFinal) === false
      ) {
        throw new CacheError(
          `Live Match Redis FINAL conflicts with durable facts for event ${eventId}`,
          'LIVE_MATCH_FINAL_REDIS_CONFLICT',
        );
      }
    }

    if (durableMatchPair && canProbeServingPair) {
      // A valid Redis pair with a different identity is not automatically a
      // recoverable cache miss.  The durable pair is immutable authority, but
      // rotating a conflicting Redis pair into `previous` would make stale
      // facts readable during a later active-pointer fault.  Only restore when
      // at least one serving sibling is missing/corrupt, or when both siblings
      // are semantically the same facts under a different publication id.
      const servingPairIsComplete = Boolean(observedDeskRead && observedDetailRead);
      const survivingDeskIsVerified =
        !observedDeskRead ||
        (observedDeskRead.publication.season === season.seasonCode &&
          observedDeskRead.publication.eventId === eventId &&
          canonicalJson(observedDeskRead.fixtures) ===
            canonicalJson(durableMatchPair.desk.fixtures) &&
          (observedDeskRead.publication.state !== 'FINALIZED' ||
            observedDeskRead.publication.checkpointedAt !== null));
      const survivingDetailIsVerified =
        !observedDetailRead ||
        (observedDetailRead.publication.season === season.seasonCode &&
          observedDetailRead.publication.eventId === eventId &&
          observedDetailRead.publication.fixtureIdentityRevision ===
            durableMatchPair.detail.publication.fixtureIdentityRevision &&
          canonicalJson(observedDetailRead.fixtures) ===
            canonicalJson(durableMatchPair.detail.fixtures) &&
          (observedDetailRead.publication.finalized !== true ||
            observedDetailRead.publication.checkpointedAt !== null));
      if (!survivingDeskIsVerified || !survivingDetailIsVerified) {
        throw new CacheError(
          `Live Match Redis sibling conflicts with durable facts for event ${eventId}`,
          'LIVE_MATCH_FINAL_REDIS_CONFLICT',
        );
      }
      const servingPairIsEquivalent =
        servingPairIsComplete &&
        canonicalJson(observedDeskRead!.fixtures) ===
          canonicalJson(durableMatchPair.desk.fixtures) &&
        canonicalJson(observedDetailRead!.fixtures) ===
          canonicalJson(durableMatchPair.detail.fixtures) &&
        observedDetailRead!.publication.fixtureIdentityRevision ===
          durableMatchPair.detail.publication.fixtureIdentityRevision;
      if (servingPairIsComplete && !servingPairIsEquivalent) {
        throw new CacheError(
          `Live Match Redis FINAL conflicts with durable facts for event ${eventId}`,
          'LIVE_MATCH_FINAL_REDIS_CONFLICT',
        );
      }
      // A complete durable pair can repair a missing/corrupt Redis serving
      // namespace without any provider dependency. Restore both siblings in
      // one fenced CAS, then capture the resulting pointers for any later
      // observation path.
      await (dependencies.restoreFinalMatchPair ?? restoreLiveMatchEquivalentFinalPairV3)({
        deskCheckpoint: durableMatchPair.desk,
        detailCheckpoint: durableMatchPair.detail,
        observedDesk: observedMatchDesk!,
        observedDetail: observedMatchDetail!,
        redis: undefined,
      });
      [observedMatchDesk, observedMatchDetail] = await Promise.all([
        dependencies.readObservedMatchDesk!({
          season: season.seasonCode,
          eventId,
        }),
        dependencies.readObservedMatchDetail!({
          season: season.seasonCode,
          eventId,
        }),
      ]);
      if (
        !isServingFinalMatchPair(
          observedMatchDesk,
          observedMatchDetail,
          season,
          eventId,
          durableMatchPair,
        )
      ) {
        throw new CacheError(
          `Live Match final pair restore did not produce the durable identity for event ${eventId}`,
          'LIVE_MATCH_EQUIVALENT_PAIR_FAILED',
        );
      }
      return;
    }

    // Live Points is already immutable here. Rebuild only the missing Match
    // sibling from a fresh observation; this preserves the final publication
    // without repeating its global fact preparation or checkpoint write.
    const fixtureIdentityStartedAt = Date.now();
    const expectedFixtureIdsPromise = dependencies
      .getExpectedFixtureIds(season, eventId)
      .catch((error) => {
        if (
          durableFinal.publication.season === season.seasonCode &&
          durableFinal.publication.eventId === eventId
        ) {
          return durableFinal.fixtures.map((fixture) => fixture.id);
        }
        throw error;
      })
      .finally(() => {
        fixtureIdentityReadMs = Math.max(0, Date.now() - fixtureIdentityStartedAt);
      });
    const referenceStartedAt = Date.now();
    const referenceDataPromise = dependencies
      .getReferenceData(season, eventId, databaseBudget?.readDb)
      .finally(() => {
        referenceReadMs = Math.max(0, Date.now() - referenceStartedAt);
      });
    const fixturesPromise = options.observedFixtures
      ? Promise.resolve([...options.observedFixtures])
      : dependencies.getFixtures(eventId);
    const matchProviderStartedAt = Date.now();
    const providerObservationPromise = Promise.allSettled([
      dependencies.getEventLive(eventId),
      fixturesPromise,
    ] as const).finally(() => {
      providerMs = Math.max(0, Date.now() - matchProviderStartedAt);
    });
    const supportObservationPromise = Promise.allSettled([
      expectedFixtureIdsPromise,
      referenceDataPromise,
    ] as const);
    const [providerObservation, supportObservation] = await Promise.all([
      providerObservationPromise,
      supportObservationPromise,
    ]);
    const [liveResult, fixturesResult] = providerObservation;
    const [expectedFixtureIdsResult, referenceDataResult] = supportObservation;
    if (liveResult.status === 'rejected') throw liveResult.reason;
    if (fixturesResult.status === 'rejected') throw fixturesResult.reason;
    if (expectedFixtureIdsResult.status === 'rejected') throw expectedFixtureIdsResult.reason;
    if (referenceDataResult.status === 'rejected') throw referenceDataResult.reason;

    // Validate the provider observation against the durable Live Points FINAL
    // on every path, including production's injected Match synchronizer.  A
    // custom synchronizer does not replace this authority check; it only
    // controls how the already-validated facts are persisted.
    let preparedObservation: PreparedLiveSnapshot;
    try {
      preparedObservation = prepareCoherentLiveSnapshot(
        eventId,
        liveResult.value,
        fixturesResult.value,
        referenceDataResult.value,
        expectedFixtureIdsResult.value,
        durableFinal.eventLives.map((row) => row.elementId),
      );
    } catch (error) {
      throw new CacheError(
        `Live Match recovery observation is not coherent with the durable Live Points FINAL for event ${eventId}`,
        'LIVE_MATCH_FINAL_FACTS_UNAVAILABLE',
        error instanceof Error ? error : undefined,
      );
    }
    if (
      canonicalJson(preparedObservation.eventLives.eventLives) !==
        canonicalJson(durableFinal.eventLives) ||
      canonicalJson(preparedObservation.fixtures) !== canonicalJson(durableFinal.fixtures)
    ) {
      throw new CacheError(
        `Live Match recovery observation differs from the durable Live Points FINAL for event ${eventId}`,
        'LIVE_MATCH_FINAL_FACTS_MISMATCH',
      );
    }

    const validateAcceptedMatch = async (match: LiveMatchObservationResult): Promise<void> => {
      if (match.desk.state !== 'FINALIZED' || match.detail?.finalized !== true) {
        throw new Error(
          `Live Match final publication was not complete for event ${eventId}; desk=${match.desk.state}; detail=${match.detail?.finalized === true ? 'FINALIZED' : 'UNAVAILABLE'}`,
        );
      }
      // The synchronizer is allowed to reuse an existing FINAL desk/detail.
      // Re-read both active pointers after that call and prove that the winning
      // payloads are the facts checked against the durable Live Points FINAL.
      // Production invokes this callback before forced checkpoint markers are
      // created, so a rejected winner leaves no recovery obligation behind.
      if (!canProbeServingPair) return;
      const expectedDesk = prepareLiveMatchDesk({
        eventId,
        rawFixtures: fixturesResult.value,
        referenceData: referenceDataResult.value,
        expectedFixtureIds: expectedFixtureIdsResult.value,
        finalized: true,
        lifecycleState: 'FINALIZED',
      });
      const detailReference = await resolveLiveReferenceDataForDetail(referenceDataResult.value, {
        requireEventPinnedIdentity: true,
      });
      const expectedDetail = detailReference
        ? prepareLiveMatchDetail({
            eventId,
            rawElements: liveResult.value.elements,
            rawFixtures: fixturesResult.value,
            deskFixtures: expectedDesk.fixtures,
            publishedLiveElementIds: durableFinal.eventLives.map((row) => row.elementId),
            referenceData: detailReference,
            requireEventPinnedIdentity: true,
          })
        : null;
      const [afterDesk, afterDetail] = await Promise.all([
        dependencies.readObservedMatchDesk!({ season: season.seasonCode, eventId }),
        dependencies.readObservedMatchDetail!({ season: season.seasonCode, eventId }),
      ]);
      const deskIdentityAgrees =
        !afterDesk.read?.publication ||
        (afterDesk.read.publication.publicationId === match.desk.publicationId &&
          afterDesk.read.publication.generation === match.desk.generation);
      const detailIdentityAgrees =
        !afterDetail.read?.publication ||
        !match.detail ||
        (afterDetail.read.publication.publicationId === match.detail.publicationId &&
          afterDetail.read.publication.generation === match.detail.generation);
      if (
        !afterDesk.read ||
        !afterDetail.read ||
        !deskIdentityAgrees ||
        !detailIdentityAgrees ||
        canonicalJson(afterDesk.read.fixtures) !== canonicalJson(expectedDesk.fixtures) ||
        canonicalJson(afterDetail.read.fixtures) !==
          canonicalJson(expectedDetail?.fixtures ?? []) ||
        canonicalJson(match.deskFixtures) !== canonicalJson(expectedDesk.fixtures) ||
        canonicalJson(match.detailFixtures ?? []) !== canonicalJson(expectedDetail?.fixtures ?? [])
      ) {
        throw new CacheError(
          `Live Match recovery did not publish facts for event ${eventId}`,
          'LIVE_MATCH_FINAL_FACTS_MISMATCH',
        );
      }
    };
    const syncLiveMatches = dependencies.syncLiveMatches ?? syncLiveMatchesV3FromObservation;
    const usesDefaultSynchronizer = syncLiveMatches === syncLiveMatchesV3FromObservation;
    const match = await syncLiveMatches({
      season,
      eventId,
      rawEventLive: liveResult.value,
      rawFixtures: fixturesResult.value,
      expectedFixtureIds: expectedFixtureIdsResult.value,
      referenceData: referenceDataResult.value,
      publishedLiveElementIds: durableFinal.eventLives.map((row) => row.elementId),
      finalizeEvent: true,
      lifecycleState: 'FINALIZED',
      expectedNextCheckAt: options.expectedNextCheckAt,
      observedDesk: observedMatchDesk,
      observedDetail: observedMatchDetail,
      forceCheckpointRecovery: true,
      expectedFinalCheckpointIdentities,
      databaseRead: databaseBudget?.readDb,
      ...(usesDefaultSynchronizer ? { approveCheckpointRecovery: validateAcceptedMatch } : {}),
    });
    // Hermetic synchronizer seams do not implement the approval callback; keep
    // their existing post-call contract while production defers forced markers
    // until validateAcceptedMatch has completed.
    if (!usesDefaultSynchronizer) await validateAcceptedMatch(match);
  };
  // A FINAL must be reconciled with its durable checkpoint before provider
  // work. Provisional heartbeats keep their provider observation independent of
  // a slow durable read; a FINAL request waits for the already-started read so
  // a missing or provisional Redis head cannot trigger a duplicate global pull.
  const reconcileDurableFinalBeforeProvider =
    options.finalizeEvent === true || current?.publication.state === 'FINALIZED';
  const earlyDurableFinalRead = reconcileDurableFinalBeforeProvider
    ? await durableReadPromise
    : null;
  if (earlyDurableFinalRead) controlReadMs = durableReadMs;

  // A FINAL request must fail closed when its durable authority cannot be
  // read.  Proceeding with provider work in this state could create a new
  // Redis publication while an older PostgreSQL FINAL is still authoritative,
  // and would turn a transient database outage into an identity conflict.
  if (options.finalizeEvent === true && earlyDurableFinalRead?.failed) {
    throw new CacheError(
      `Live Points V2 durable FINAL read failed during finalization for ${season.seasonCode}:${eventId}`,
      'LIVE_V2_DURABLE_FINAL_READ_FAILED',
    );
  }

  if (current?.publication.state === 'FINALIZED' && earlyDurableFinalRead?.failed) {
    // Keep the Redis FINAL serving while making the durable uncertainty visible
    // to the caller. The worker retains the scheduler obligation for retry.
    return {
      eventId,
      changed: false,
      stale: true,
      published: false,
      generation: current.publication.generation,
      publicationId: current.publication.publicationId,
      sourceCheckedAt: current.publication.sourceCheckedAt,
      state: 'FINALIZED',
      eventLiveCount: current.eventLives.length,
      fixtureCount: current.fixtures.length,
      checkpointScheduled: false,
      checkpointed: false,
      checkpointObligationFailed: false,
      stageTimings: stageTimings(),
    };
  }

  const durableFinal =
    earlyDurableFinalRead &&
    !earlyDurableFinalRead.failed &&
    isDurableFinalPublication(earlyDurableFinalRead.value, season, eventId)
      ? earlyDurableFinalRead.value
      : null;
  if (durableFinal) {
    const servingIdentityMatches = isCompleteFinalPublication(
      current,
      durableFinal,
      season,
      eventId,
    );
    let servingPublication = current?.publication ?? durableFinal.publication;
    let restored = false;
    if (!servingIdentityMatches) {
      // A complete durable FINAL outranks a missing, damaged, or provisional
      // Redis head. Restore its exact identity through the existing Lua CAS
      // before any provider request or replacement generation is considered.
      const redisStartedAt = Date.now();
      const restoredPublication = await activatePublication(() =>
        (dependencies.restoreLivePublicationCheckpoint ?? restoreLivePublicationV2Checkpoint)({
          checkpoint: durableFinal,
        }),
      );
      redisPublishMs = Math.max(0, Date.now() - redisStartedAt);
      if (!restoredPublication.published) {
        throw new CacheError(
          `Live Points V2 durable FINAL restore did not publish ${durableFinal.publication.publicationId} for ${season.seasonCode}:${eventId}`,
          'LIVE_V2_CHECKPOINT_RESTORE_FAILED',
        );
      }
      servingPublication = restoredPublication.publication;
      restored = true;
      logInfo('Restored durable FINALIZED Live Points V2 publication before provider work', {
        season: season.seasonCode,
        eventId,
        generation: servingPublication.generation,
        publicationId: servingPublication.publicationId,
        trigger: options.trigger ?? 'queue',
      });
    }

    if (options.finalizeEvent === true) await repairMatchForReusedFinal(durableFinal);
    try {
      const readDesired = dependencies.readCheckpointDesired ?? readLiveCheckpointDesiredV2;
      const clearDesired = dependencies.clearCheckpointDesired ?? clearLiveCheckpointDesiredV2;
      const desired = await readDesired({
        season: season.seasonCode,
        eventId,
      });
      if (
        desired &&
        desired.publicationId === servingPublication.publicationId &&
        desired.generation === servingPublication.generation
      ) {
        await clearDesired(desired);
      }
    } catch (error) {
      // A complete FINAL remains valid if best-effort marker cleanup is
      // temporarily unavailable; the retention reconciler can clear it later.
      logError('Live Points V2 complete FINAL desired-marker cleanup failed', error, {
        season: season.seasonCode,
        eventId,
        publicationId: servingPublication.publicationId,
        generation: servingPublication.generation,
      });
    }
    return {
      eventId,
      changed: false,
      stale: restored,
      published: false,
      generation: servingPublication.generation,
      publicationId: servingPublication.publicationId,
      sourceCheckedAt: servingPublication.sourceCheckedAt,
      state: 'FINALIZED',
      eventLiveCount: durableFinal.eventLives.length,
      fixtureCount: durableFinal.fixtures.length,
      checkpointScheduled: false,
      checkpointed: true,
      checkpointObligationFailed: false,
      stageTimings: stageTimings(),
    };
  }
  // Capture the exact Match desk pointer before any FPL request begins. A
  // slower older observation must lose its desk CAS if a newer observation
  // publishes while its provider response is in flight. Custom unit callers
  // may omit this read; the direct Match service then keeps its legacy local
  // read behaviour without changing the production fence.
  const observedMatchDeskPromise = dependencies.readObservedMatchDesk
    ? dependencies.readObservedMatchDesk({ season: season.seasonCode, eventId })
    : Promise.resolve(undefined);
  const observedMatchDetailPromise = dependencies.readObservedMatchDetail
    ? dependencies.readObservedMatchDetail({ season: season.seasonCode, eventId })
    : Promise.resolve(undefined);
  const providerStartedAt = Date.now();
  const expectedFixtureIdsStartedAt = Date.now();
  const expectedFixtureIdsPromise = dependencies
    .getExpectedFixtureIds(season, eventId)
    .catch((error) => {
      // The immutable same-event publication is an exact fixture-identity
      // baseline during a Core Redis outage. This keeps PostgreSQL out of the
      // producer hot path without accepting a guessed or cross-event set.
      if (
        current?.publication.season === season.seasonCode &&
        current.publication.eventId === eventId
      ) {
        return current.fixtures.map((fixture) => fixture.id);
      }
      throw error;
    })
    .finally(() => {
      fixtureIdentityReadMs = Math.max(0, Date.now() - expectedFixtureIdsStartedAt);
    });
  const eventLivePromise = dependencies.getEventLive(eventId);
  const fixturesPromise = options.observedFixtures
    ? Promise.resolve([...options.observedFixtures])
    : dependencies.getFixtures(eventId);
  const referenceDataStartedAt = Date.now();
  const referenceDataPromise = dependencies
    .getReferenceData(season, eventId, databaseBudget?.readDb)
    .finally(() => {
      referenceReadMs = Math.max(0, Date.now() - referenceDataStartedAt);
    });
  // Provider timing deliberately covers only the two upstream FPL requests.
  // Reference/fixture identity reads are concurrent support stages and must
  // remain visible in their own buckets instead of making a database fallback
  // look like provider latency.
  const providerObservationPromise = Promise.allSettled([
    eventLivePromise,
    fixturesPromise,
  ] as const).then((result) => {
    providerMs = Math.max(0, Date.now() - providerStartedAt);
    return result;
  });
  const supportObservationPromise = Promise.allSettled([
    expectedFixtureIdsPromise,
    referenceDataPromise,
  ] as const);
  const observationPromise = Promise.all([
    providerObservationPromise,
    supportObservationPromise,
  ]).then(([provider, support]) => [provider[0], provider[1], support[0], support[1]] as const);
  const nonFinalMatchLifecycleState =
    options.lifecycleState === 'FINALIZED' ? 'GW_REVIEW' : options.lifecycleState;
  // The score desk depends only on the fixture response and an exact fixture
  // identity baseline. It must not wait for event-live detail or a Core/DB
  // identity fallback once a self-contained Match desk already exists.
  // Finalization deliberately stays in the complete phase below so a failed
  // detail observation cannot lock the desk into FINALIZED by itself.
  const earlyMatchDeskOutcome = Promise.allSettled([
    fixturesPromise,
    expectedFixtureIdsPromise,
  ] as const)
    .then(async ([fixturesResult, expectedFixtureIdsResult]) => {
      if (fixturesResult.status === 'rejected') throw fixturesResult.reason;
      const observedDesk = await observedMatchDeskPromise;
      return (dependencies.syncLiveMatches ?? syncLiveMatchesV3FromObservation)({
        season,
        eventId,
        rawFixtures: fixturesResult.value,
        expectedFixtureIds:
          expectedFixtureIdsResult.status === 'fulfilled'
            ? expectedFixtureIdsResult.value
            : undefined,
        publishedLiveElementIds: current?.eventLives.map((row) => row.elementId),
        finalizeEvent: false,
        lifecycleState: nonFinalMatchLifecycleState,
        expectedNextCheckAt: options.expectedNextCheckAt,
        observedDesk,
        databaseRead: databaseBudget?.readDb,
      });
    })
    .then((result) => ({ result, error: null as unknown }))
    .catch((error: unknown) => ({ result: null, error }));
  const matchPublicationOutcome = observationPromise
    .then(async ([liveResult, fixturesResult, expectedFixtureIdsResult, referenceDataResult]) => {
      if (fixturesResult.status === 'rejected') throw fixturesResult.reason;
      const early = await earlyMatchDeskOutcome;
      const rawFixtures = fixturesResult.value;
      const observedDesk = await observedMatchDeskPromise;
      const observedDetail = await observedMatchDetailPromise;
      const expectedFixtureIds =
        expectedFixtureIdsResult.status === 'fulfilled'
          ? expectedFixtureIdsResult.value
          : undefined;
      if (referenceDataResult.status === 'fulfilled') {
        const result = await (dependencies.syncLiveMatches ?? syncLiveMatchesV3FromObservation)({
          season,
          eventId,
          rawFixtures,
          rawEventLive: liveResult.status === 'fulfilled' ? liveResult.value : undefined,
          referenceData: referenceDataResult.value,
          expectedFixtureIds,
          publishedLiveElementIds: current?.eventLives.map((row) => row.elementId),
          // The sibling Match publication must remain provisional until the
          // exact same observation has passed Live Points completeness and
          // final-facts validation below. Finalizing here would let an event-
          // live/reference mismatch make Match immutable first.
          finalizeEvent: false,
          lifecycleState: nonFinalMatchLifecycleState,
          expectedNextCheckAt: options.expectedNextCheckAt,
          observedDesk,
          observedDetail,
          databaseRead: databaseBudget?.readDb,
          publishedDesk:
            early.result === null
              ? undefined
              : await publishedDeskFromMatchResult(
                  early.result,
                  dependencies.readObservedMatchDesk,
                ),
        });
        if (options.finalizeEvent && liveResult.status === 'rejected') throw liveResult.reason;
        return { result, error: null as unknown };
      }
      if (liveResult.status === 'rejected' || referenceDataResult.status === 'rejected') {
        if (options.finalizeEvent) {
          throw liveResult.status === 'rejected'
            ? liveResult.reason
            : referenceDataResult.status === 'rejected'
              ? referenceDataResult.reason
              : new Error('Live Match final detail observation is unavailable');
        }
        if (early.error) throw early.error;
        return { result: early.result, error: null as unknown };
      }
      throw new Error('Live Match observation reached an impossible settled state');
    })
    .catch((error: unknown) => {
      logError('Live Matches V3 sibling publication failed', error, {
        season: season.seasonCode,
        eventId,
      });
      return { result: null, error };
    });
  const settleMatchPublication = async (): Promise<void> => {
    const outcome = await matchPublicationOutcome;
    if (outcome.result?.checkpointObligationFailed === true) {
      matchCheckpointObligationFailed = true;
    }
    // At the final boundary both publications are exact durable obligations and
    // therefore fail closed together. During a provisional poll, Match errors
    // remain non-fatal to Live Points, but the promise is still awaited before
    // the scheduler can settle the shared job and lose publication evidence.
    if (options.finalizeEvent && outcome.error) throw outcome.error;
  };

  const requireProvisionalMatchDetail = async (): Promise<void> => {
    if (!options.finalizeEvent) return;
    const outcome = await matchPublicationOutcome;
    if (outcome.error) throw outcome.error;
    const result = outcome.result;
    if (!result)
      throw new Error(`Live Match provisional publication is unavailable for event ${eventId}`);
    // A blank gameweek has no fixture-grain player detail to validate. Its
    // finalized empty detail is created in the final Match phase below. Any
    // non-empty desk, however, must have a complete compatible detail before
    // the immutable Live Points FINAL is allowed to publish.
    if (result.deskFixtures.length === 0) return;
    if (
      result.detail === null ||
      result.detailUnavailableReason !== null ||
      result.detail.finalized ||
      result.detail.observedDeskGeneration !== result.desk.generation ||
      result.detail.fixtureIdentityRevision !== result.desk.revisions.fixtureIdentity.revision
    ) {
      throw new Error(
        `Live Match provisional detail is unavailable before Live Points final publication for event ${eventId}`,
      );
    }
  };

  const finalizeAcceptedMatch = async (observation: AcceptedMatchObservation): Promise<void> => {
    if (!options.finalizeEvent) return;
    const outcome = await matchPublicationOutcome;
    const publishedDesk = outcome.result
      ? await publishedDeskFromMatchResult(outcome.result, dependencies.readObservedMatchDesk)
      : undefined;
    const observedDetail = outcome.result
      ? await detailFenceForFinalization(outcome.result, dependencies.readObservedMatchDetail)
      : undefined;
    const result = await (dependencies.syncLiveMatches ?? syncLiveMatchesV3FromObservation)({
      season,
      eventId,
      rawFixtures: observation.rawFixtures,
      rawEventLive: observation.rawEventLive,
      referenceData: observation.referenceData,
      expectedFixtureIds: observation.expectedFixtureIds,
      publishedLiveElementIds: current?.eventLives.map((row) => row.elementId),
      finalizeEvent: true,
      lifecycleState: 'FINALIZED',
      expectedNextCheckAt: options.expectedNextCheckAt,
      observedDetail,
      publishedDesk,
      databaseRead: databaseBudget?.readDb,
    });
    if (result.checkpointObligationFailed === true) {
      matchCheckpointObligationFailed = true;
    }
    if (result.desk.state !== 'FINALIZED' || result.detail?.finalized !== true) {
      throw new Error(
        `Live Match final publication was not complete for event ${eventId}; desk=${result.desk.state}; detail=${result.detail?.finalized === true ? 'FINALIZED' : 'UNAVAILABLE'}`,
      );
    }
  };

  let matchCheckpointObligationFailed = false;
  const durableRead = await durableReadPromise;
  // `controlReadMs` is kept for the existing stage contract, but it now means
  // the durable database control read only. Redis latency is reported by
  // `redisReadMs` and cannot trigger a PostgreSQL budget warning.
  controlReadMs = durableReadMs;
  const durableFloor = durableRead.value;
  const recoveringFinalCheckpoint =
    current?.publication.state === 'FINALIZED' && !durableRead.failed && !durableFloor;
  if (current?.publication.state === 'FINALIZED' && (durableRead.failed || !durableFloor)) {
    if (!durableRead.failed) {
      // Redis can retain a FINAL manifest after PostgreSQL has been restored
      // from an older backup.  Do not checkpoint the Redis event/fixture
      // payloads directly: the publication is only complete after the same
      // coherent upstream response reconstructs scoring explains and
      // player-fixture evidence.  The recovery path below performs that read
      // and either checkpoints all facts or leaves one desired obligation.
    } else {
      // A failed durable read cannot prove that the row is absent. Keep the
      // immutable Redis FINAL in service and retry the durable read later.
      await settleMatchPublication();
      return {
        eventId,
        changed: false,
        stale: true,
        published: false,
        generation: current.publication.generation,
        publicationId: current.publication.publicationId,
        sourceCheckedAt: current.publication.sourceCheckedAt,
        state: 'FINALIZED',
        eventLiveCount: current.eventLives.length,
        fixtureCount: current.fixtures.length,
        checkpointScheduled: false,
        checkpointed: current.publication.checkpointedAt !== null,
        checkpointObligationFailed: matchCheckpointObligationFailed,
        stageTimings: stageTimings(),
      };
    }
  }
  if (
    durableFloor?.publication.state === 'FINALIZED' &&
    !(
      current?.servedFrom === 'REDIS_CURRENT' &&
      current.publication.publicationId === durableFloor.publication.publicationId &&
      current.publication.generation === durableFloor.publication.generation
    )
  ) {
    // FINALIZED is an immutable durable boundary. Restore that exact
    // checkpoint before considering any newly fetched provisional candidate;
    // otherwise a fresh generation could supersede final data.
    const redisStartedAt = Date.now();
    const restored = await activatePublication(() =>
      (dependencies.restoreLivePublicationCheckpoint ?? restoreLivePublicationV2Checkpoint)({
        checkpoint: durableFloor,
      }),
    );
    redisPublishMs = Math.max(0, Date.now() - redisStartedAt);
    // A stale response is not proof that the durable FINAL is serving. Even
    // an equal identity must be rejected here: the active pointer or its
    // immutable items may still be invalid, and returning success would leave
    // the next sync retrying the same ineffective restore forever.
    if (!restored.published) {
      throw new CacheError(
        `Live Points V2 durable FINAL restore did not publish ${durableFloor.publication.publicationId} for ${season.seasonCode}:${eventId}`,
        'LIVE_V2_CHECKPOINT_RESTORE_FAILED',
      );
    }
    logInfo('Restored durable FINALIZED Live Points V2 publication', {
      season: season.seasonCode,
      eventId,
      generation: restored.publication.generation,
      publicationId: restored.publication.publicationId,
      published: restored.published,
      trigger: options.trigger ?? 'queue',
    });
    await settleMatchPublication();
    if (options.finalizeEvent) {
      const [liveResult, fixturesResult, expectedFixtureIdsResult, referenceDataResult] =
        await observationPromise;
      if (liveResult.status === 'rejected') throw liveResult.reason;
      if (fixturesResult.status === 'rejected') throw fixturesResult.reason;
      if (expectedFixtureIdsResult.status === 'rejected') throw expectedFixtureIdsResult.reason;
      if (referenceDataResult.status === 'rejected') throw referenceDataResult.reason;
      await finalizeAcceptedMatch({
        rawEventLive: liveResult.value,
        rawFixtures: fixturesResult.value,
        referenceData: referenceDataResult.value,
        expectedFixtureIds: expectedFixtureIdsResult.value,
      });
    }
    return {
      eventId,
      changed: false,
      stale: true,
      published: false,
      generation: restored.publication.generation,
      publicationId: restored.publication.publicationId,
      sourceCheckedAt: restored.publication.sourceCheckedAt,
      state: 'FINALIZED',
      eventLiveCount: durableFloor.eventLives.length,
      fixtureCount: durableFloor.fixtures.length,
      checkpointScheduled: false,
      checkpointed: true,
      checkpointObligationFailed: matchCheckpointObligationFailed,
      stageTimings: stageTimings(),
    };
  }

  let prepared: PreparedLiveSnapshot;
  let acceptedMatchObservation: AcceptedMatchObservation | null = null;
  try {
    const [liveResult, fixturesResult, expectedFixtureIdsResult, referenceDataResult] =
      await observationPromise;
    await settleMatchPublication();

    const liveResponse = liveResult.status === 'fulfilled' ? liveResult.value : undefined;
    const rawFixtures = fixturesResult.status === 'fulfilled' ? fixturesResult.value : undefined;

    if (liveResult.status === 'rejected') throw liveResult.reason;
    if (fixturesResult.status === 'rejected') throw fixturesResult.reason;
    if (expectedFixtureIdsResult.status === 'rejected') throw expectedFixtureIdsResult.reason;
    if (referenceDataResult.status === 'rejected') throw referenceDataResult.reason;
    if (liveResponse === undefined || rawFixtures === undefined) {
      throw new Error(
        `Live observation did not produce complete upstream facts for event ${eventId}`,
      );
    }
    acceptedMatchObservation = {
      rawEventLive: liveResponse,
      rawFixtures,
      referenceData: referenceDataResult.value,
      expectedFixtureIds: expectedFixtureIdsResult.value,
    };
    prepared = prepareCoherentLiveSnapshot(
      eventId,
      liveResponse,
      rawFixtures,
      referenceDataResult.value,
      expectedFixtureIdsResult.value,
      current?.eventLives.map((row) => row.elementId),
    );
  } catch (error) {
    if (!recoveringFinalCheckpoint || !current) throw error;
    logError('Live Points V2 final recovery facts unavailable', error, {
      season: season.seasonCode,
      eventId,
      publicationId: current.publication.publicationId,
      generation: current.publication.generation,
    });
    const desired = await ensureFinalRecoveryDesired(season, eventId, current.publication);
    return {
      eventId,
      changed: false,
      stale: true,
      published: false,
      generation: current.publication.generation,
      publicationId: current.publication.publicationId,
      sourceCheckedAt: current.publication.sourceCheckedAt,
      state: 'FINALIZED',
      eventLiveCount: current.eventLives.length,
      fixtureCount: current.fixtures.length,
      checkpointScheduled: desired !== null,
      checkpointed: false,
      checkpointObligationFailed: matchCheckpointObligationFailed,
      stageTimings: stageTimings(),
    };
  }

  if (recoveringFinalCheckpoint && current) {
    const factsMatch =
      canonicalJson(current.eventLives) === canonicalJson(prepared.eventLives.eventLives) &&
      canonicalJson(current.fixtures) === canonicalJson(prepared.fixtures);
    if (!factsMatch) {
      // A changed upstream response must never supersede an immutable FINAL
      // merely because its durable checkpoint is missing.  Keep the FINAL,
      // record one obligation, and wait for a source response that proves the
      // exact publication facts before checkpointing it.
      logError(
        'Live Points V2 final recovery facts differ from Redis FINAL',
        new Error('fact mismatch'),
        {
          season: season.seasonCode,
          eventId,
          publicationId: current.publication.publicationId,
          generation: current.publication.generation,
          eventLiveCount: current.eventLives.length,
          preparedEventLiveCount: prepared.eventLives.eventLives.length,
          fixtureCount: current.fixtures.length,
          preparedFixtureCount: prepared.fixtures.length,
        },
      );
      const desired = await ensureFinalRecoveryDesired(season, eventId, current.publication);
      return {
        eventId,
        changed: false,
        stale: true,
        published: false,
        generation: current.publication.generation,
        publicationId: current.publication.publicationId,
        sourceCheckedAt: current.publication.sourceCheckedAt,
        state: 'FINALIZED',
        eventLiveCount: current.eventLives.length,
        fixtureCount: current.fixtures.length,
        checkpointScheduled: desired !== null,
        checkpointed: false,
        checkpointObligationFailed: matchCheckpointObligationFailed,
        stageTimings: stageTimings(),
      };
    }

    const desired = await ensureFinalRecoveryDesired(season, eventId, current.publication);
    // The immutable FINAL keeps its original publication source timestamp,
    // but the coherent recovery fetch is a new observation. Carry that
    // observation through the relational ordering fence so a later core
    // heartbeat cannot permanently reject recovery of the same facts.
    const observationCheckedAt = new Date();
    const checkpointStartedAt = Date.now();
    const checkpointed = await checkpoint(
      dependencies,
      season,
      eventId,
      {
        eventLives: prepared.eventLives.eventLives,
        fixtures: prepared.fixtures,
        explains: prepared.eventLives.explains,
        fixtureEvidence: prepared.eventLives.fixtureEvidence,
      },
      current.publication,
      desired,
      observationCheckedAt,
      databaseBudget,
      options.schedulerLaneFence,
    );
    checkpointMs = Math.max(0, Date.now() - checkpointStartedAt);
    if (acceptedMatchObservation) await finalizeAcceptedMatch(acceptedMatchObservation);
    return {
      eventId,
      changed: false,
      stale: true,
      published: false,
      generation: current.publication.generation,
      publicationId: current.publication.publicationId,
      sourceCheckedAt: current.publication.sourceCheckedAt,
      state: 'FINALIZED',
      eventLiveCount: current.eventLives.length,
      fixtureCount: current.fixtures.length,
      checkpointScheduled: !checkpointed && desired !== null,
      checkpointed,
      checkpointObligationFailed: matchCheckpointObligationFailed,
      stageTimings: stageTimings(),
    };
  }
  // This timestamp is evidence that the coherent fetch and all completeness
  // checks finished successfully. Starting the clock before upstream work
  // would make a slow/partially failed observation look fresher than it is.
  const sourceCheckedAt = new Date();
  const state = publicationState(prepared, options.finalizeEvent === true);
  const generationFloor = Math.max(
    current?.publication.generation ?? 0,
    durableFloor?.publication.generation ?? 0,
  );
  const durableGenerationConflict = Boolean(
    current &&
      durableFloor &&
      (durableFloor.publication.generation > current.publication.generation ||
        (durableFloor.publication.generation === current.publication.generation &&
          durableFloor.publication.publicationId !== current.publication.publicationId)),
  );
  if (
    samePayload(current, prepared, state) &&
    current?.servedFrom === 'REDIS_CURRENT' &&
    !durableGenerationConflict
  ) {
    const redisStartedAt = Date.now();
    const touched = await activatePublication(() =>
      touchLivePublicationV2(
        current.publication,
        sourceCheckedAt,
        options.expectedNextCheckAt ?? null,
      ),
    );
    redisPublishMs = Math.max(0, Date.now() - redisStartedAt);
    const publication = touched ?? current.publication;
    let desired = await readLiveCheckpointDesiredV2({
      season: season.seasonCode,
      eventId,
    });
    const checkpointDue = shouldCheckpoint(
      current,
      state,
      options.finalizeEvent === true,
      publication,
      desired?.requestedAt ?? null,
    );
    if (publication.checkpointedAt === null && desired === null) {
      try {
        desired = await setLiveCheckpointDesiredV2(publication);
      } catch (error) {
        logError('Live Points V2 checkpoint obligation repair failed', error, {
          season: season.seasonCode,
          eventId,
          publicationId: publication.publicationId,
          generation: publication.generation,
        });
      }
    }
    const checkpointStartedAt = checkpointDue ? Date.now() : null;
    const checkpointed = checkpointDue
      ? await checkpoint(
          dependencies,
          season,
          eventId,
          {
            eventLives: prepared.eventLives.eventLives,
            fixtures: prepared.fixtures,
            explains: prepared.eventLives.explains,
            fixtureEvidence: prepared.eventLives.fixtureEvidence,
          },
          publication,
          desired,
          undefined,
          databaseBudget,
          options.schedulerLaneFence,
        )
      : false;
    checkpointMs =
      checkpointStartedAt === null ? null : Math.max(0, Date.now() - checkpointStartedAt);
    const servedPublication = checkpointed
      ? ((await dependencies.readPublished(season.seasonCode, eventId))?.publication ?? publication)
      : publication;
    if (acceptedMatchObservation) await finalizeAcceptedMatch(acceptedMatchObservation);
    return {
      eventId,
      changed: false,
      stale: false,
      published: false,
      generation: servedPublication.generation,
      publicationId: servedPublication.publicationId,
      sourceCheckedAt: servedPublication.sourceCheckedAt,
      state,
      eventLiveCount: prepared.eventLives.eventLives.length,
      fixtureCount: prepared.fixtures.length,
      checkpointScheduled: desired !== null,
      checkpointed: publication.checkpointedAt !== null || checkpointed,
      checkpointObligationFailed: matchCheckpointObligationFailed,
      stageTimings: stageTimings(),
    };
  }

  await requireProvisionalMatchDetail();

  const redisStartedAt = Date.now();
  const promoted = await activatePublication(() =>
    publishLivePublicationV2({
      season: season.seasonCode,
      eventId,
      state,
      sourceCheckedAt,
      expectedNextCheckAt: options.expectedNextCheckAt ?? null,
      eventLives: prepared.eventLives.eventLives,
      fixtures: prepared.fixtures,
      previous: current?.publication ?? null,
      generationFloor,
    }),
  );
  redisPublishMs = Math.max(0, Date.now() - redisStartedAt);
  if (!promoted.published) {
    // A stale result is an ordering/finalization fence, not a publication
    // failure. In particular, once FINALIZED is current, never checkpoint the
    // newly fetched provisional payload against the retained final manifest.
    return {
      eventId,
      changed: false,
      stale: true,
      published: false,
      generation: promoted.publication.generation,
      publicationId: promoted.publication.publicationId,
      sourceCheckedAt: promoted.publication.sourceCheckedAt,
      state: promoted.publication.state,
      eventLiveCount: current?.eventLives.length ?? 0,
      fixtureCount: current?.fixtures.length ?? 0,
      checkpointScheduled: false,
      checkpointed: promoted.publication.checkpointedAt !== null,
      checkpointObligationFailed: matchCheckpointObligationFailed,
      stageTimings: stageTimings(),
    };
  }
  if (acceptedMatchObservation) await finalizeAcceptedMatch(acceptedMatchObservation);
  let desired = await readLiveCheckpointDesiredV2({
    season: season.seasonCode,
    eventId,
  });
  const checkpointRequired = shouldCheckpoint(
    current,
    state,
    options.finalizeEvent === true,
    promoted.publication,
    desired?.requestedAt ?? null,
  );
  try {
    desired ??= await setLiveCheckpointDesiredV2(promoted.publication);
  } catch (error) {
    // The current publication is still authoritative. A later scheduler pass
    // can derive the same obligation from Redis current and replay it.
    logError('Live Points V2 checkpoint obligation write failed', error, {
      season: season.seasonCode,
      eventId,
      publicationId: promoted.publication.publicationId,
      generation: promoted.publication.generation,
    });
  }
  if (!checkpointRequired) {
    return {
      eventId,
      changed: true,
      stale: false,
      published: promoted.published,
      generation: promoted.publication.generation,
      publicationId: promoted.publication.publicationId,
      sourceCheckedAt: promoted.publication.sourceCheckedAt,
      state,
      eventLiveCount: prepared.eventLives.eventLives.length,
      fixtureCount: prepared.fixtures.length,
      checkpointScheduled: desired !== null,
      checkpointed: false,
      checkpointObligationFailed: matchCheckpointObligationFailed,
      stageTimings: stageTimings(),
    };
  }

  const checkpointStartedAt = Date.now();
  const checkpointed = await checkpoint(
    dependencies,
    season,
    eventId,
    {
      eventLives: prepared.eventLives.eventLives,
      fixtures: prepared.fixtures,
      explains: prepared.eventLives.explains,
      fixtureEvidence: prepared.eventLives.fixtureEvidence,
    },
    promoted.publication,
    desired,
    undefined,
    databaseBudget,
    options.schedulerLaneFence,
  );
  checkpointMs = Math.max(0, Date.now() - checkpointStartedAt);
  logInfo('Live Points V2 publication complete', {
    season: season.seasonCode,
    eventId,
    generation: promoted.publication.generation,
    publicationId: promoted.publication.publicationId,
    sourceCheckedAt: promoted.publication.sourceCheckedAt,
    state,
    checkpointed,
    trigger: options.trigger ?? 'queue',
  });
  return {
    eventId,
    changed: true,
    stale: false,
    published: promoted.published,
    generation: promoted.publication.generation,
    publicationId: promoted.publication.publicationId,
    sourceCheckedAt: promoted.publication.sourceCheckedAt,
    state,
    eventLiveCount: prepared.eventLives.eventLives.length,
    fixtureCount: prepared.fixtures.length,
    checkpointScheduled: desired !== null,
    checkpointed,
    checkpointObligationFailed: matchCheckpointObligationFailed,
    stageTimings: stageTimings(),
  };
}
