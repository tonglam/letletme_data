import type { RawFPLEventLiveResponse, RawFPLFixture } from '../types';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  liveMatchActiveEventKey,
  publishLiveMatchDeskV3,
  publishLiveMatchDetailV3,
  readLiveMatchDeskV3,
  readLiveMatchDetailV3,
  readLiveMatchCheckpointLastAtV3,
  readLiveMatchCheckpointDesiredV3,
  type MatchDeskActiveFence,
  restoreLiveMatchDeskCheckpointV3,
  restoreLiveMatchDetailCheckpointV3,
  setLiveMatchActiveEventV3,
  setLiveMatchCheckpointDesiredV3,
  touchLiveMatchDeskV3,
  touchLiveMatchDetailV3,
  type MatchDeskRead,
  type MatchDetailActiveFence,
  type MatchDetailRead,
  type MatchDeskPublication,
  type MatchDetailPublication,
} from '../cache/live-match-publication-v3';
import {
  readLiveMatchDeskCheckpointV3,
  readLiveMatchDetailCheckpointV3,
} from './live-match-v3-checkpoint.service';
import { enqueueLiveMatchCheckpoint } from '../jobs/live-data.jobs';
import {
  resolveLiveReferenceDataForDetail,
  type LiveSnapshotReferenceData,
} from './live-coherent-fetch';
import {
  hasLiveMatchDetailEvidence,
  hasStartedLiveMatchDetail,
  prepareLiveMatchDesk,
  prepareLiveMatchDetail,
  normalizeMatchLifecycleState,
  type MatchDeskFixture,
  type MatchFixtureDetail,
  type MatchLifecycleState,
} from './live-match-v3';
import { contentHash } from '../utils/content-hash';
import { logError, logInfo } from '../utils/logger';

const CHECKPOINT_INTERVAL_MS = 10 * 60_000;
const CADENCE_FRESHNESS_WINDOWS = [
  [30_000, 75_000],
  [60_000, 3 * 60_000],
  [2 * 60_000, 5 * 60_000],
  [5 * 60_000, 12 * 60_000],
  [10 * 60_000, 25 * 60_000],
  [15 * 60_000, 30 * 60_000],
] as const;

export interface LiveMatchObservation {
  readonly season: FplSeasonRef;
  readonly eventId: number;
  readonly rawFixtures: readonly RawFPLFixture[];
  /** The event-live request may fail independently after fixtures succeed. */
  readonly rawEventLive?: RawFPLEventLiveResponse;
  /** Core identity is needed for a first publication and for detail. */
  readonly referenceData?: LiveSnapshotReferenceData | null;
  /** Optional baseline. Redis desk is the preferred live identity authority. */
  readonly expectedFixtureIds?: readonly number[];
  readonly publishedLiveElementIds?: readonly number[];
  readonly finalizeEvent?: boolean;
  /** Scheduler state captured with the same observation; never fetched again. */
  readonly lifecycleState?: MatchLifecycleState;
  readonly expectedNextCheckAt?: Date | string | null;
  /** Pre-deadline warmups must not move the eventless active pointer. */
  readonly promoteActiveEvent?: boolean;
  readonly observedAt?: Date | string;
  /** Active desk pointer captured before the provider observation began. */
  readonly observedDesk?: MatchDeskActiveFence;
  /** Active detail pointer captured before the provider observation began. */
  readonly observedDetail?: MatchDetailActiveFence;
  /**
   * Desk already published from the fixture-only phase of this exact provider
   * observation. The complete phase may reuse it without another Redis read,
   * heartbeat touch, active-event write, or checkpoint decision.
   */
  readonly publishedDesk?: Readonly<{
    publication: MatchDeskPublication;
    fixtures: readonly MatchDeskFixture[];
    changed: boolean;
    checkpointScheduled: boolean;
    checkpointObligationFailed?: boolean;
    /** Exact active pointer after the fixture-phase publication. */
    observedActive: MatchDeskActiveFence;
  }>;
  readonly redis?: Parameters<typeof readLiveMatchDeskV3>[0]['redis'];
  /** Test/repair seam; production uses the coalescing checkpoint queue. */
  readonly enqueueCheckpoint?: (
    ...args: Parameters<typeof enqueueLiveMatchCheckpoint>
  ) => Promise<unknown>;
}

export interface LiveMatchObservationResult {
  readonly season: string;
  readonly eventId: number;
  readonly state: MatchLifecycleState;
  readonly desk: MatchDeskPublication;
  readonly deskFixtures: readonly MatchDeskFixture[];
  readonly detail: MatchDetailPublication | null;
  readonly deskChanged: boolean;
  readonly detailChanged: boolean;
  readonly deskCheckpointScheduled: boolean;
  readonly detailCheckpointScheduled: boolean;
  /** Redis remains available even when the checkpoint obligation write failed. */
  readonly checkpointObligationFailed?: boolean;
  readonly detailUnavailableReason: string | null;
}

function sourceDate(value: Date | string | undefined): Date {
  const date =
    value === undefined ? new Date() : value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Live Match observation time is invalid');
  return date;
}

export function liveMatchStaleAtForCadence(
  state: MatchLifecycleState,
  sourceCheckedAt: Date | string,
  expectedNextCheckAt: Date | string | null | undefined,
): Date | null {
  if (state === 'FINALIZED' || expectedNextCheckAt == null) return null;
  const checkedAt = sourceDate(sourceCheckedAt);
  const nextCheckAt = sourceDate(expectedNextCheckAt);
  const cadenceMs = Math.max(30_000, nextCheckAt.getTime() - checkedAt.getTime());
  const configured = CADENCE_FRESHNESS_WINDOWS.find(([maximum]) => cadenceMs <= maximum);
  const budgetMs = configured?.[1] ?? cadenceMs * 2;
  return new Date(checkedAt.getTime() + budgetMs);
}

function sameDesk(
  current: MatchDeskRead | null,
  fixtures: readonly unknown[],
  state: MatchLifecycleState,
): boolean {
  return Boolean(
    current &&
      current.publication.state === state &&
      contentHash(current.fixtures) === contentHash(fixtures),
  );
}

function sameDetail(
  current: MatchDetailRead | null,
  fixtures: readonly MatchFixtureDetail[],
  fixtureIdentityRevision: string,
  finalized: boolean,
): boolean {
  return Boolean(
    current &&
      current.publication.finalized === finalized &&
      current.publication.fixtureIdentityRevision === fixtureIdentityRevision &&
      contentHash(current.fixtures) === contentHash(fixtures),
  );
}

async function readDeskSafely(input: LiveMatchObservation): Promise<MatchDeskRead | null> {
  const cached = await readLiveMatchDeskV3({
    season: input.season.seasonCode,
    eventId: input.eventId,
    redis: input.redis,
  });
  const finalizationRequested =
    input.finalizeEvent === true || input.lifecycleState === 'FINALIZED';
  const cachedFinalIsCheckpointed =
    cached?.publication.state === 'FINALIZED' && cached.publication.checkpointedAt !== null;
  if (
    cached?.servedFrom === 'REDIS_CURRENT' &&
    (!finalizationRequested || cachedFinalIsCheckpointed)
  )
    return cached;

  // A missing current pointer is a recovery boundary. Use the self-contained
  // PostgreSQL checkpoint as a generation fence so a restored Redis sequence
  // cannot restart at one and be rejected forever by the durable head. A
  // durable final is restored into Redis before it is allowed to fence a new
  // provisional observation.
  try {
    const checkpoint = await readLiveMatchDeskCheckpointV3(input.season, input.eventId);
    if (
      checkpoint &&
      (cached === null ||
        checkpoint.publication.state === 'FINALIZED' ||
        checkpoint.publication.generation > cached.publication.generation)
    ) {
      if (checkpoint.publication.state === 'FINALIZED') {
        await restoreLiveMatchDeskCheckpointV3({ checkpoint, redis: input.redis });
        const restored = await readLiveMatchDeskV3({
          season: input.season.seasonCode,
          eventId: input.eventId,
          redis: input.redis,
        });
        if (restored) return restored;
      }
      return checkpoint;
    }
  } catch (error) {
    // The checkpoint is only a cold recovery aid. Redis remains the serving
    // authority, and the caller can still publish from its exact fixture
    // baseline when PostgreSQL is unavailable.
    logError('Live Match desk durable generation recovery read failed', error, {
      season: input.season.seasonCode,
      eventId: input.eventId,
    });
  }
  return cached;
}

async function readDetailSafely(input: LiveMatchObservation): Promise<MatchDetailRead | null> {
  const cached = await readLiveMatchDetailV3({
    season: input.season.seasonCode,
    eventId: input.eventId,
    redis: input.redis,
  });
  const finalizationRequested =
    input.finalizeEvent === true || input.lifecycleState === 'FINALIZED';
  const cachedFinalIsCheckpointed =
    cached?.publication.finalized === true && cached.publication.checkpointedAt !== null;
  if (
    cached?.servedFrom === 'REDIS_CURRENT' &&
    (!finalizationRequested || cachedFinalIsCheckpointed)
  )
    return cached;

  try {
    const checkpoint = await readLiveMatchDetailCheckpointV3(input.season, input.eventId);
    if (
      checkpoint &&
      (cached === null ||
        checkpoint.publication.finalized ||
        checkpoint.publication.generation > cached.publication.generation)
    ) {
      if (checkpoint.publication.finalized) {
        await restoreLiveMatchDetailCheckpointV3({ checkpoint, redis: input.redis });
        const restored = await readLiveMatchDetailV3({
          season: input.season.seasonCode,
          eventId: input.eventId,
          redis: input.redis,
        });
        if (restored) return restored;
      }
      return checkpoint;
    }
  } catch (error) {
    logError('Live Match detail durable generation recovery read failed', error, {
      season: input.season.seasonCode,
      eventId: input.eventId,
    });
  }
  return cached;
}

function detailIsStarted(fixtures: readonly RawFPLFixture[]): boolean {
  return fixtures.some(
    (fixture) =>
      fixture.started === true ||
      fixture.minutes > 0 ||
      fixture.finished ||
      fixture.finished_provisional,
  );
}

function detailHasRequiredCoverage(
  deskFixtures: readonly MatchDeskFixture[],
  detail: readonly MatchFixtureDetail[],
  finalized: boolean,
): boolean {
  if (detail.length !== deskFixtures.length) return false;
  const detailByFixture = new Map(detail.map((fixture) => [fixture.fixtureId, fixture]));
  if (detailByFixture.size !== detail.length) return false;
  return deskFixtures.every((fixture) => {
    const detailFixture = detailByFixture.get(fixture.fixtureId);
    const started =
      fixture.started || fixture.finished || fixture.finishedProvisional || fixture.minutes > 0;
    if (!detailFixture) return false;
    return !(started || finalized) || detailFixture.players.length > 0;
  });
}

async function scheduleCheckpoint(
  kind: 'desk' | 'detail',
  publication: MatchDeskPublication | MatchDetailPublication,
  redis: LiveMatchObservation['redis'],
  season: FplSeasonRef,
  finalized = false,
  boundary = false,
  enqueueCheckpoint: LiveMatchObservation['enqueueCheckpoint'] = enqueueLiveMatchCheckpoint,
): Promise<{ scheduled: boolean; failed: boolean }> {
  if (publication.checkpointedAt !== null) return { scheduled: false, failed: false };
  try {
    const [lastCheckpointedAt, existingDesired] = await Promise.all([
      readLiveMatchCheckpointLastAtV3({
        kind,
        season: publication.season,
        eventId: publication.eventId,
        redis,
      }),
      readLiveMatchCheckpointDesiredV3({
        kind,
        season: publication.season,
        eventId: publication.eventId,
        redis,
      }),
    ]);
    const desired = await setLiveMatchCheckpointDesiredV3({
      kind,
      publication,
      finalized,
      force: boundary,
      redis,
    });
    const lastMs = lastCheckpointedAt === null ? Number.NaN : Date.parse(lastCheckpointedAt);
    const due =
      finalized ||
      boundary ||
      desired.force ||
      !Number.isFinite(lastMs) ||
      Date.now() - lastMs >= CHECKPOINT_INTERVAL_MS ||
      existingDesired?.final === true;
    if (!due) return { scheduled: false, failed: false };
    await enqueueCheckpoint(
      season,
      publication.eventId,
      kind,
      desired.publicationId,
      desired.generation,
    );
    return { scheduled: true, failed: false };
  } catch (error) {
    logError('Live Matches V3 checkpoint obligation write failed', error, {
      season: publication.season,
      eventId: publication.eventId,
      kind,
      publicationId: publication.publicationId,
      generation: publication.generation,
    });
    return { scheduled: false, failed: true };
  }
}

/**
 * Publish the two Live Matches V3 streams from one already-fetched observation. The
 * function never performs provider I/O. PostgreSQL is consulted only when the
 * Redis current/previous pointers are absent, so a recovered Redis namespace
 * can inherit the durable generation fence without putting a DB read on the
 * normal hot path. Desk publication is the gate; detail is best-effort and may
 * remain on its compatible LKG.
 */
export async function syncLiveMatchesV3FromObservation(
  input: LiveMatchObservation,
): Promise<LiveMatchObservationResult> {
  const finalizationRequested =
    input.finalizeEvent === true || input.lifecycleState === 'FINALIZED';
  if (
    input.publishedDesk &&
    (input.publishedDesk.publication.season !== input.season.seasonCode ||
      input.publishedDesk.publication.eventId !== input.eventId)
  ) {
    throw new Error('Live Match published desk scope does not match observation');
  }
  const currentDesk: MatchDeskRead | null =
    !finalizationRequested && input.publishedDesk
      ? {
          publication: input.publishedDesk.publication,
          fixtures: input.publishedDesk.fixtures,
          servedFrom: 'REDIS_CURRENT',
        }
      : !finalizationRequested && input.observedDesk !== undefined
        ? input.observedDesk.read
        : await readDeskSafely(input);
  const deskIsFinal = currentDesk?.publication.state === 'FINALIZED';
  const expectedFixtureIds =
    input.expectedFixtureIds ?? currentDesk?.fixtures.map((fixture) => fixture.fixtureId);
  if (!deskIsFinal && expectedFixtureIds === undefined) {
    throw new Error(
      `Live Match fixture identity authority is unavailable for event ${input.eventId}`,
    );
  }
  const preparedDesk = deskIsFinal
    ? { eventId: input.eventId, state: 'FINALIZED' as const, fixtures: currentDesk.fixtures }
    : prepareLiveMatchDesk({
        eventId: input.eventId,
        rawFixtures: input.rawFixtures,
        referenceData: input.referenceData ?? null,
        expectedFixtureIds,
        previousFixtures: currentDesk?.fixtures,
        finalized: input.finalizeEvent,
        lifecycleState: normalizeMatchLifecycleState(input.lifecycleState),
      });
  const observedAt = sourceDate(input.observedAt);
  const staleAt = liveMatchStaleAtForCadence(
    preparedDesk.state,
    observedAt,
    input.expectedNextCheckAt,
  );
  const reusesPublishedDesk = Boolean(
    !finalizationRequested &&
      input.publishedDesk &&
      currentDesk?.publication.publicationId === input.publishedDesk.publication.publicationId &&
      currentDesk.publication.generation === input.publishedDesk.publication.generation &&
      sameDesk(currentDesk, preparedDesk.fixtures, preparedDesk.state),
  );
  let desk = deskIsFinal || reusesPublishedDesk ? (currentDesk?.publication ?? null) : null;
  let deskChanged = reusesPublishedDesk ? (input.publishedDesk?.changed ?? false) : false;

  if (
    !deskIsFinal &&
    !reusesPublishedDesk &&
    sameDesk(currentDesk, preparedDesk.fixtures, preparedDesk.state) &&
    currentDesk?.servedFrom === 'REDIS_CURRENT'
  ) {
    const touched = await touchLiveMatchDeskV3({
      publication: currentDesk.publication,
      sourceCheckedAt: observedAt,
      expectedNextCheckAt: input.expectedNextCheckAt,
      staleAt,
      observedActive: input.publishedDesk?.observedActive ?? input.observedDesk,
      redis: input.redis,
    });
    desk = touched ?? null;
  }
  if (!desk && !deskIsFinal) {
    const published = await publishLiveMatchDeskV3({
      season: input.season.seasonCode,
      eventId: input.eventId,
      state: preparedDesk.state,
      fixtures: preparedDesk.fixtures,
      sourceCheckedAt: observedAt,
      expectedNextCheckAt: input.expectedNextCheckAt,
      staleAt,
      previous: currentDesk,
      observedActive: input.publishedDesk?.observedActive ?? input.observedDesk,
      generationFloor: currentDesk?.publication.generation ?? 0,
      redis: input.redis,
    });
    // The publisher returns the winning publication when a concurrent writer
    // has already advanced this scope. Never replace it with the stale value
    // read before promotion.
    desk = published.publication;
    deskChanged = published.published;
  }
  if (!desk) throw new Error(`Live Match desk did not publish for event ${input.eventId}`);
  if (!reusesPublishedDesk && input.promoteActiveEvent !== false) {
    await setLiveMatchActiveEventV3({
      season: input.season.seasonCode,
      eventId: input.eventId,
      redis: input.redis,
    });
  }

  const deskCheckpoint = reusesPublishedDesk
    ? {
        scheduled: input.publishedDesk?.checkpointScheduled ?? false,
        failed: input.publishedDesk?.checkpointObligationFailed === true,
      }
    : await scheduleCheckpoint(
        'desk',
        desk,
        input.redis,
        input.season,
        desk.state === 'FINALIZED',
        !currentDesk ||
          currentDesk.publication.state !== desk.state ||
          currentDesk.publication.revisions.fixtureIdentity.revision !==
            desk.revisions.fixtureIdentity.revision,
        input.enqueueCheckpoint,
      );
  const deskCheckpointScheduled = deskCheckpoint.scheduled;
  let checkpointObligationFailed = deskCheckpoint.failed;
  let detail: MatchDetailPublication | null = null;
  let detailChanged = false;
  let detailCheckpointScheduled = false;
  let detailUnavailableReason: string | null = null;

  if (!input.rawEventLive) {
    detailUnavailableReason = 'EVENT_LIVE_FETCH_FAILED';
  } else if (!input.referenceData?.playerById) {
    detailUnavailableReason = 'PLAYER_IDENTITY_UNAVAILABLE';
  } else {
    try {
      const detailInput = {
        eventId: input.eventId,
        rawElements: input.rawEventLive.elements,
        rawFixtures: input.rawFixtures,
        deskFixtures: preparedDesk.fixtures,
        publishedLiveElementIds: input.publishedLiveElementIds,
      } as const;
      let preparedDetail: ReturnType<typeof prepareLiveMatchDetail> | null = null;

      if (finalizationRequested && preparedDesk.fixtures.length > 0) {
        // Resolve fixture identity before preparing any final candidate. The
        // current roster is never used as a final evidence probe, because a
        // transferred player can make that probe fail or pass under the wrong
        // club. Raw explain/BPS evidence is classified separately only when
        // enrichment is unavailable.
        const detailReferenceData = await resolveLiveReferenceDataForDetail(input.referenceData, {
          requireEventPinnedIdentity: true,
        });
        if (!detailReferenceData) {
          if (
            !hasLiveMatchDetailEvidence({
              ...detailInput,
              finalized: preparedDesk.state === 'FINALIZED',
            })
          ) {
            detailUnavailableReason = 'DETAIL_EVIDENCE_INCOMPLETE';
          } else {
            throw new Error('Live Match final detail requires event-pinned player identity');
          }
        } else {
          preparedDetail = prepareLiveMatchDetail({
            ...detailInput,
            referenceData: detailReferenceData,
            requireEventPinnedIdentity: true,
          });
        }
      } else {
        const detailReferenceData = await resolveLiveReferenceDataForDetail(input.referenceData);
        if (!detailReferenceData) {
          throw new Error('Live Match detail reference data is unavailable');
        }
        preparedDetail = prepareLiveMatchDetail({
          ...detailInput,
          referenceData: detailReferenceData,
        });
      }

      const preparedDetailComplete = preparedDetail
        ? detailHasRequiredCoverage(
            preparedDesk.fixtures,
            preparedDetail.fixtures,
            preparedDesk.state === 'FINALIZED',
          )
        : false;
      const loadedDetail = await readDetailSafely(input);
      const currentDetail =
        loadedDetail &&
        detailHasRequiredCoverage(
          preparedDesk.fixtures,
          loadedDetail.fixtures,
          loadedDetail.publication.finalized,
        )
          ? loadedDetail
          : null;
      if (
        preparedDesk.state === 'FINALIZED' &&
        currentDetail?.publication.finalized === true &&
        currentDetail.publication.observedDeskGeneration === desk.generation &&
        currentDetail.publication.fixtureIdentityRevision ===
          desk.revisions.fixtureIdentity.revision
      ) {
        // A complete FINAL detail is immutable. In particular, do not create
        // a new final generation merely because the current player roster has
        // since changed a price or display name for this historical event.
        // The dedicated retention lane owns its lease and durable recovery.
        detail = currentDetail.publication;
      } else if (!preparedDetailComplete) {
        // Empty explain/BPS evidence is a transient provider regression, not a
        // valid new detail publication. Keep the complete same-fixture LKG and
        // wait for a candidate with the required player coverage.
        detailUnavailableReason ??= 'DETAIL_EVIDENCE_INCOMPLETE';
      } else if (preparedDetail) {
        const completeDetail = preparedDetail;
        if (
          sameDetail(
            currentDetail,
            completeDetail.fixtures,
            desk.revisions.fixtureIdentity.revision,
            desk.state === 'FINALIZED',
          ) &&
          currentDetail?.publication.finalized !== true &&
          currentDetail?.publication.observedDeskGeneration === desk.generation &&
          currentDetail?.servedFrom === 'REDIS_CURRENT'
        ) {
          detail = await touchLiveMatchDetailV3({
            publication: currentDetail.publication,
            sourceCheckedAt: observedAt,
            expectedNextCheckAt: input.expectedNextCheckAt,
            staleAt,
            observedActive: input.observedDetail,
            redis: input.redis,
          });
        }
        if (
          !detail &&
          (detailIsStarted(input.rawFixtures) ||
            hasStartedLiveMatchDetail(preparedDesk.fixtures, completeDetail) ||
            preparedDesk.state === 'FINALIZED')
        ) {
          const published = await publishLiveMatchDetailV3({
            season: input.season.seasonCode,
            eventId: input.eventId,
            observedDeskGeneration: desk.generation,
            fixtureIdentityRevision: desk.revisions.fixtureIdentity.revision,
            fixtures: completeDetail.fixtures,
            sourceCheckedAt: observedAt,
            expectedNextCheckAt: input.expectedNextCheckAt,
            staleAt,
            previous: currentDetail,
            observedActive: input.observedDetail,
            generationFloor: currentDetail?.publication.generation ?? 0,
            finalized: preparedDesk.state === 'FINALIZED',
            redis: input.redis,
          });
          detail = published.publication;
          detailChanged = published.published;
        }
      }
      if (
        !detail &&
        currentDetail?.publication.fixtureIdentityRevision ===
          desk.revisions.fixtureIdentity.revision
      ) {
        // A failed detail candidate must not erase a complete same-fixture
        // LKG merely because the desk advanced. New detail publications are
        // still fenced to the current desk generation above; this fallback
        // intentionally serves the older detail with its own generation so
        // consumers can surface its independent staleness.
        detail = currentDetail.publication;
      }
      if (!detail && !detailIsStarted(input.rawFixtures)) detailUnavailableReason = 'PRE_KICKOFF';
      if (!detail && detailUnavailableReason === null)
        detailUnavailableReason = 'DETAIL_NOT_PUBLISHED';
      if (detail) {
        const detailCheckpoint = await scheduleCheckpoint(
          'detail',
          detail,
          input.redis,
          input.season,
          detail.finalized,
          !currentDetail ||
            currentDetail.publication.fixtureIdentityRevision !== detail.fixtureIdentityRevision,
          input.enqueueCheckpoint,
        );
        detailCheckpointScheduled = detailCheckpoint.scheduled;
        checkpointObligationFailed ||= detailCheckpoint.failed;
      }
    } catch (error) {
      detailUnavailableReason = 'DETAIL_CANDIDATE_INVALID';
      logError('Live Matches V3 detail candidate rejected; keeping desk', error, {
        season: input.season.seasonCode,
        eventId: input.eventId,
        deskGeneration: desk.generation,
      });
      const currentDetail = await readDetailSafely(input).catch(() => null);
      if (
        currentDetail?.publication.fixtureIdentityRevision ===
          desk.revisions.fixtureIdentity.revision &&
        detailHasRequiredCoverage(
          preparedDesk.fixtures,
          currentDetail.fixtures,
          currentDetail.publication.finalized,
        )
      ) {
        detail = currentDetail.publication;
      }
    }
  }

  logInfo('Live Matches V3 observation published', {
    season: input.season.seasonCode,
    eventId: input.eventId,
    state: desk.state,
    deskGeneration: desk.generation,
    deskChanged,
    detailGeneration: detail?.generation ?? null,
    detailChanged,
    detailUnavailableReason,
  });
  return {
    season: input.season.seasonCode,
    eventId: input.eventId,
    state: desk.state,
    desk,
    deskFixtures: preparedDesk.fixtures,
    detail,
    deskChanged,
    detailChanged,
    deskCheckpointScheduled,
    detailCheckpointScheduled,
    checkpointObligationFailed,
    detailUnavailableReason,
  };
}

export { liveMatchActiveEventKey };
