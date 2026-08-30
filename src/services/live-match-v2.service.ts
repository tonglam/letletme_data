import type { RawFPLEventLiveResponse, RawFPLFixture } from '../types';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  liveMatchActiveEventKey,
  publishLiveMatchDeskV2,
  publishLiveMatchDetailV2,
  readLiveMatchDeskV2,
  readLiveMatchDetailV2,
  readLiveMatchCheckpointLastAtV2,
  readLiveMatchCheckpointDesiredV2,
  setLiveMatchActiveEventV2,
  setLiveMatchCheckpointDesiredV2,
  touchLiveMatchDeskV2,
  touchLiveMatchDetailV2,
  type MatchDeskRead,
  type MatchDetailRead,
  type MatchDeskPublication,
  type MatchDetailPublication,
} from '../cache/live-match-publication-v2';
import { enqueueLiveMatchCheckpoint } from '../jobs/live-data.jobs';
import type { LiveSnapshotReferenceData } from './live-coherent-fetch';
import {
  hasStartedLiveMatchDetail,
  prepareLiveMatchDesk,
  prepareLiveMatchDetail,
  normalizeMatchLifecycleState,
  type MatchFixtureDetail,
  type MatchLifecycleState,
} from './live-match-v2';
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
  readonly observedAt?: Date | string;
  readonly redis?: Parameters<typeof readLiveMatchDeskV2>[0]['redis'];
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
  readonly detail: MatchDetailPublication | null;
  readonly deskChanged: boolean;
  readonly detailChanged: boolean;
  readonly deskCheckpointScheduled: boolean;
  readonly detailCheckpointScheduled: boolean;
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
  return readLiveMatchDeskV2({
    season: input.season.seasonCode,
    eventId: input.eventId,
    redis: input.redis,
  });
}

async function readDetailSafely(input: LiveMatchObservation): Promise<MatchDetailRead | null> {
  return readLiveMatchDetailV2({
    season: input.season.seasonCode,
    eventId: input.eventId,
    redis: input.redis,
  });
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

async function scheduleCheckpoint(
  kind: 'desk' | 'detail',
  publication: MatchDeskPublication | MatchDetailPublication,
  redis: LiveMatchObservation['redis'],
  season: FplSeasonRef,
  finalized = false,
  boundary = false,
  enqueueCheckpoint: LiveMatchObservation['enqueueCheckpoint'] = enqueueLiveMatchCheckpoint,
): Promise<boolean> {
  if (publication.checkpointedAt !== null) return false;
  try {
    const [lastCheckpointedAt, existingDesired] = await Promise.all([
      readLiveMatchCheckpointLastAtV2({
        kind,
        season: publication.season,
        eventId: publication.eventId,
        redis,
      }),
      readLiveMatchCheckpointDesiredV2({
        kind,
        season: publication.season,
        eventId: publication.eventId,
        redis,
      }),
    ]);
    const desired = await setLiveMatchCheckpointDesiredV2({
      kind,
      publication,
      finalized,
      redis,
    });
    const lastMs = lastCheckpointedAt === null ? Number.NaN : Date.parse(lastCheckpointedAt);
    const due =
      finalized ||
      boundary ||
      !Number.isFinite(lastMs) ||
      Date.now() - lastMs >= CHECKPOINT_INTERVAL_MS ||
      existingDesired?.final === true;
    if (!due) return false;
    await enqueueCheckpoint(
      season,
      publication.eventId,
      kind,
      desired.publicationId,
      desired.generation,
    );
    return true;
  } catch (error) {
    logError('Live Matches V2 checkpoint obligation write failed', error, {
      season: publication.season,
      eventId: publication.eventId,
      kind,
      publicationId: publication.publicationId,
      generation: publication.generation,
    });
    return false;
  }
}

/**
 * Publish the two Match V2 streams from one already-fetched observation. The
 * function never performs provider or PostgreSQL I/O. Desk publication is the
 * gate; detail is best-effort and may remain on its compatible LKG.
 */
export async function syncLiveMatchesV2FromObservation(
  input: LiveMatchObservation,
): Promise<LiveMatchObservationResult> {
  const currentDesk = await readDeskSafely(input);
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
  let desk = deskIsFinal ? (currentDesk?.publication ?? null) : null;
  let deskChanged = false;

  if (
    !deskIsFinal &&
    sameDesk(currentDesk, preparedDesk.fixtures, preparedDesk.state) &&
    currentDesk?.servedFrom === 'REDIS_CURRENT'
  ) {
    const touched = await touchLiveMatchDeskV2({
      publication: currentDesk.publication,
      sourceCheckedAt: observedAt,
      expectedNextCheckAt: input.expectedNextCheckAt,
      staleAt,
      redis: input.redis,
    });
    desk = touched ?? null;
  }
  if (!desk && !deskIsFinal) {
    const published = await publishLiveMatchDeskV2({
      season: input.season.seasonCode,
      eventId: input.eventId,
      state: preparedDesk.state,
      fixtures: preparedDesk.fixtures,
      sourceCheckedAt: observedAt,
      expectedNextCheckAt: input.expectedNextCheckAt,
      staleAt,
      previous: currentDesk,
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
  await setLiveMatchActiveEventV2({
    season: input.season.seasonCode,
    eventId: input.eventId,
    redis: input.redis,
  });

  const deskCheckpointScheduled = await scheduleCheckpoint(
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
      const preparedDetail = prepareLiveMatchDetail({
        eventId: input.eventId,
        rawElements: input.rawEventLive.elements,
        rawFixtures: input.rawFixtures,
        deskFixtures: preparedDesk.fixtures,
        referenceData: input.referenceData,
        publishedLiveElementIds: input.publishedLiveElementIds,
      });
      const currentDetail = await readDetailSafely(input);
      if (
        sameDetail(
          currentDetail,
          preparedDetail.fixtures,
          desk.revisions.fixtureIdentity.revision,
          desk.state === 'FINALIZED',
        ) &&
        currentDetail?.publication.finalized !== true &&
        currentDetail?.servedFrom === 'REDIS_CURRENT'
      ) {
        detail = await touchLiveMatchDetailV2({
          publication: currentDetail.publication,
          sourceCheckedAt: observedAt,
          expectedNextCheckAt: input.expectedNextCheckAt,
          staleAt,
          redis: input.redis,
        });
      }
      if (
        !detail &&
        (detailIsStarted(input.rawFixtures) ||
          hasStartedLiveMatchDetail(preparedDesk.fixtures, preparedDetail))
      ) {
        const published = await publishLiveMatchDetailV2({
          season: input.season.seasonCode,
          eventId: input.eventId,
          observedDeskGeneration: desk.generation,
          fixtureIdentityRevision: desk.revisions.fixtureIdentity.revision,
          fixtures: preparedDetail.fixtures,
          sourceCheckedAt: observedAt,
          expectedNextCheckAt: input.expectedNextCheckAt,
          staleAt,
          previous: currentDetail,
          generationFloor: currentDetail?.publication.generation ?? 0,
          finalized: preparedDesk.state === 'FINALIZED',
          redis: input.redis,
        });
        detail = published.publication;
        detailChanged = published.published;
      }
      if (
        !detail &&
        currentDetail?.publication.fixtureIdentityRevision ===
          desk.revisions.fixtureIdentity.revision
      ) {
        detail = currentDetail.publication;
      }
      if (!detail && !detailIsStarted(input.rawFixtures)) detailUnavailableReason = 'PRE_KICKOFF';
      if (!detail && detailUnavailableReason === null)
        detailUnavailableReason = 'DETAIL_NOT_PUBLISHED';
      if (detail)
        detailCheckpointScheduled = await scheduleCheckpoint(
          'detail',
          detail,
          input.redis,
          input.season,
          desk.state === 'FINALIZED',
          !currentDetail ||
            currentDetail.publication.fixtureIdentityRevision !== detail.fixtureIdentityRevision,
          input.enqueueCheckpoint,
        );
    } catch (error) {
      detailUnavailableReason = 'DETAIL_CANDIDATE_INVALID';
      logError('Live Matches V2 detail candidate rejected; keeping desk', error, {
        season: input.season.seasonCode,
        eventId: input.eventId,
        deskGeneration: desk.generation,
      });
      const currentDetail = await readDetailSafely(input).catch(() => null);
      if (
        currentDetail?.publication.fixtureIdentityRevision ===
        desk.revisions.fixtureIdentity.revision
      ) {
        detail = currentDetail.publication;
      }
    }
  }

  logInfo('Live Matches V2 observation published', {
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
    detail,
    deskChanged,
    detailChanged,
    deskCheckpointScheduled,
    detailCheckpointScheduled,
    detailUnavailableReason,
  };
}

export { liveMatchActiveEventKey };
