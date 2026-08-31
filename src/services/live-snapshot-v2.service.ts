import { fplClient } from '../clients/fpl';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEventLiveResponse, RawFPLFixture } from '../types';
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
  readLiveMatchDeskFenceV2,
  readLiveMatchDetailFenceV2,
  type MatchDeskActiveFence,
  type MatchDetailActiveFence,
} from '../cache/live-match-publication-v2';
import {
  loadLiveReferenceData,
  prepareCoherentLiveSnapshot,
  type LiveSnapshotReferenceData,
  type PreparedLiveSnapshot,
} from './live-coherent-fetch';
import {
  checkpointLivePublicationV2,
  readLivePublicationV2Checkpoint,
} from './live-publication-v2-checkpoint.service';
import {
  syncLiveMatchesV2FromObservation,
  type LiveMatchObservationResult,
} from './live-match-v2.service';
import type { MatchLifecycleState } from './live-match-v2';
import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import { logError, logInfo } from '../utils/logger';
import { canonicalJson } from '../utils/content-hash';
import { CacheError } from '../utils/errors';

const SCORE_CHECKPOINT_INTERVAL_MS = 10 * 60_000;

export interface LiveSnapshotV2SyncOptions {
  readonly finalizeEvent?: boolean;
  readonly lifecycleState?: MatchLifecycleState;
  readonly trigger?: 'cron' | 'manual' | 'cascade' | 'catchup' | 'reconcile';
  readonly sourceRunId?: string;
  readonly expectedNextCheckAt?: Date | string | null;
  readonly dependencies?: LiveSnapshotV2Dependencies;
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
    eventId?: number,
  ) => Promise<LiveSnapshotReferenceData>;
  readonly readObservedMatchDesk?: typeof readLiveMatchDeskFenceV2;
  readonly readObservedMatchDetail?: typeof readLiveMatchDetailFenceV2;
  readonly syncLiveMatches?: typeof syncLiveMatchesV2FromObservation;
  readonly readPublished: (season: string, eventId: number) => Promise<LivePublicationRead | null>;
  readonly readCheckpointed?: (
    season: FplSeasonRef,
    eventId: number,
  ) => Promise<LivePublicationRead | null>;
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
}

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
  readObservedMatchDesk: (input) => readLiveMatchDeskFenceV2(input),
  readObservedMatchDetail: (input) => readLiveMatchDetailFenceV2(input),
  getReferenceData: (season, eventId) => loadLiveReferenceData(season, eventId),
  syncLiveMatches: syncLiveMatchesV2FromObservation,
  readPublished: (season, eventId) => readLivePublicationV2({ season, eventId }),
  readCheckpointed: readLivePublicationV2Checkpoint,
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
        return Date.now() - requestedAt >= SCORE_CHECKPOINT_INTERVAL_MS;
      }
    }
    return true;
  }
  if (desiredRequestedAt !== null) {
    const requestedAt = Date.parse(desiredRequestedAt);
    if (Number.isFinite(requestedAt)) {
      return Date.now() - requestedAt >= SCORE_CHECKPOINT_INTERVAL_MS;
    }
  }
  const checkpointedAt = Date.parse(current.publication.checkpointedAt);
  return (
    !Number.isFinite(checkpointedAt) || Date.now() - checkpointedAt >= SCORE_CHECKPOINT_INTERVAL_MS
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
  readObservedMatchDesk?: typeof readLiveMatchDeskFenceV2,
): Promise<NonNullable<Parameters<typeof syncLiveMatchesV2FromObservation>[0]['publishedDesk']>> {
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
    observedActive,
  };
}

async function detailFenceForFinalization(
  result: LiveMatchObservationResult,
  readObservedMatchDetail?: typeof readLiveMatchDetailFenceV2,
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
  const dependencies = options.dependencies ?? defaultDependencies;
  // Redis is the serving authority, but a rebuilt Redis sequence must not be
  // allowed to fence an older durable checkpoint forever. Start that durable
  // read in parallel; it must never delay the shared provider observation used
  // by the independent Live Matches Redis publication.
  const durableReadPromise = (dependencies.readCheckpointed ?? readLivePublicationV2Checkpoint)(
    season,
    eventId,
  )
    .then((value) => ({ value, failed: false as const }))
    .catch((error) => {
      logError('Live Points V2 durable checkpoint read failed', error, {
        season: season.seasonCode,
        eventId,
      });
      return { value: null, failed: true as const };
    });
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
    });
  const eventLivePromise = dependencies.getEventLive(eventId);
  const fixturesPromise = dependencies.getFixtures(eventId);
  const referenceDataPromise = dependencies.getReferenceData(
    season,
    options.finalizeEvent === true || current?.publication.state === 'FINALIZED'
      ? eventId
      : undefined,
  );
  const observationPromise = Promise.allSettled([
    eventLivePromise,
    fixturesPromise,
    expectedFixtureIdsPromise,
    referenceDataPromise,
  ] as const);
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
      const observedDetail = await observedMatchDetailPromise;
      return (dependencies.syncLiveMatches ?? syncLiveMatchesV2FromObservation)({
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
        observedDetail,
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
        const result = await (dependencies.syncLiveMatches ?? syncLiveMatchesV2FromObservation)({
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
      logError('Live Matches V2 sibling publication failed', error, {
        season: season.seasonCode,
        eventId,
      });
      return { result: null, error };
    });
  const settleMatchPublication = async (): Promise<void> => {
    const outcome = await matchPublicationOutcome;
    // Live Matches is a sibling publication: a provisional Match failure must
    // not make an otherwise coherent Live Points publication unavailable. We
    // still await the sibling so the sync job cannot report completion while
    // Redis publication work is continuing in the background. At the final
    // boundary both publications are exact durable obligations and therefore
    // fail closed together.
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
    const result = await (dependencies.syncLiveMatches ?? syncLiveMatchesV2FromObservation)({
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
    });
    if (result.desk.state !== 'FINALIZED' || result.detail?.finalized !== true) {
      throw new Error(
        `Live Match final publication was not complete for event ${eventId}; desk=${result.desk.state}; detail=${result.detail?.finalized === true ? 'FINALIZED' : 'UNAVAILABLE'}`,
      );
    }
  };

  const durableRead = await durableReadPromise;
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
    const restored = await restoreLivePublicationV2Checkpoint({
      checkpoint: durableFloor,
    });
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
      };
    }

    const desired = await ensureFinalRecoveryDesired(season, eventId, current.publication);
    // The immutable FINAL keeps its original publication source timestamp,
    // but the coherent recovery fetch is a new observation. Carry that
    // observation through the relational ordering fence so a later core
    // heartbeat cannot permanently reject recovery of the same facts.
    const observationCheckedAt = new Date();
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
    );
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
    const touched = await touchLivePublicationV2(
      current.publication,
      sourceCheckedAt,
      options.expectedNextCheckAt ?? null,
    );
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
        )
      : false;
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
    };
  }

  await requireProvisionalMatchDetail();

  const promoted = await publishLivePublicationV2({
    season: season.seasonCode,
    eventId,
    state,
    sourceCheckedAt,
    expectedNextCheckAt: options.expectedNextCheckAt ?? null,
    eventLives: prepared.eventLives.eventLives,
    fixtures: prepared.fixtures,
    previous: current?.publication ?? null,
    generationFloor,
  });
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
    };
  }

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
  );
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
  };
}
