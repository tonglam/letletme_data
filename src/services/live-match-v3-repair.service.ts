import {
  liveMatchDeskKey,
  liveMatchDetailKey,
  promotePreviousLiveMatchV3,
  readLiveMatchCheckpointDesiredV3,
  readLiveMatchDeskV3,
  readLiveMatchDeskFenceV3,
  readLiveMatchDeskPointerV3,
  readLiveMatchDetailFenceV3,
  readLiveMatchDetailPointerV3,
  restoreLiveMatchEquivalentFinalPairV3,
  restoreLiveMatchDeskCheckpointV3,
  restoreLiveMatchDetailCheckpointV3,
  setLiveMatchCheckpointDesiredV3,
  type MatchDeskRead,
  type MatchDetailActiveFence,
  type MatchDetailRead,
} from '../cache/live-match-publication-v3';
import { redisSingleton } from '../cache/singleton';
import { enqueueLiveMatchCheckpoint } from '../jobs/live-data.jobs';
import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import {
  readLiveMatchDeskCheckpointV3,
  readLiveMatchDetailCheckpointV3,
} from './live-match-v3-checkpoint.service';
import { ForbiddenError, ValidationError } from '../utils/errors';
import { canonicalJson } from '../utils/content-hash';

export const LIVE_MATCHES_V3_REPAIR_CONFIRMATION = 'LIVE_MATCHES_V3_REPAIR';

export type LiveMatchesV3RepairAction =
  | 'inspect'
  | 'promote-previous'
  | 'rebuild-current'
  | 'replay-checkpoint'
  | 'restore-equivalent-final-pair';
export type LiveMatchesV3RepairKind = 'desk' | 'detail';

export type LiveMatchesV3RepairRequest = Readonly<{
  action: LiveMatchesV3RepairAction;
  season: string;
  eventId: number;
  kind: LiveMatchesV3RepairKind | null;
  reason: string | null;
  confirmation: string | null;
}>;

const REPAIR_ACTIONS = new Set<LiveMatchesV3RepairAction>([
  'inspect',
  'promote-previous',
  'rebuild-current',
  'replay-checkpoint',
  'restore-equivalent-final-pair',
]);
const REPAIR_KINDS = new Set<LiveMatchesV3RepairKind>(['desk', 'detail']);
const REQUEST_FIELDS = new Set(['action', 'season', 'eventId', 'kind', 'reason', 'confirmation']);

function invalidRequest(message: string): never {
  throw new ValidationError(message, 'LIVE_MATCH_REPAIR_REQUEST_INVALID');
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidRequest('Live Matches repair request must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!REQUEST_FIELDS.has(key)) invalidRequest(`Unsupported Live Matches repair field: ${key}`);
  }
  return record;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalidRequest(`${field} must be a string when provided`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalExactString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalidRequest(`${field} must be a string when provided`);
  return value.length > 0 ? value : null;
}

/** Validate one exact operator scope before any Redis or PostgreSQL access. */
export function parseLiveMatchesV3RepairRequest(value: unknown): LiveMatchesV3RepairRequest {
  const record = requestRecord(value);
  const action = record.action;
  if (typeof action !== 'string' || !REPAIR_ACTIONS.has(action as LiveMatchesV3RepairAction)) {
    invalidRequest(
      'action must be inspect, promote-previous, rebuild-current, replay-checkpoint, or restore-equivalent-final-pair',
    );
  }
  const season = record.season;
  if (typeof season !== 'string' || !/^\d{4}$/.test(season)) {
    invalidRequest('season must be a four-digit season code');
  }
  const eventId = record.eventId;
  if (typeof eventId !== 'number' || !Number.isSafeInteger(eventId) || eventId <= 0) {
    invalidRequest('eventId must be a positive integer');
  }
  const rawKind = record.kind;
  if (
    action === 'restore-equivalent-final-pair' &&
    Object.prototype.hasOwnProperty.call(record, 'kind')
  ) {
    invalidRequest('restore-equivalent-final-pair requires kind to be omitted');
  }
  const kind = rawKind === undefined || rawKind === null ? null : optionalString(rawKind, 'kind');
  if (kind !== null && !REPAIR_KINDS.has(kind as LiveMatchesV3RepairKind)) {
    invalidRequest('kind must be desk or detail');
  }
  const reason = optionalString(record.reason, 'reason');
  if (action !== 'inspect' && action !== 'restore-equivalent-final-pair') {
    if (kind === null) invalidRequest('write repairs require an exact desk or detail kind');
    if (reason === null || reason.length < 12) {
      invalidRequest('write repairs require a reason with at least 12 characters');
    }
  }
  if (action === 'restore-equivalent-final-pair') {
    if (reason === null || reason.length < 12) {
      invalidRequest('restore-equivalent-final-pair requires a reason with at least 12 characters');
    }
  }
  const confirmation = optionalExactString(record.confirmation, 'confirmation');
  return {
    action: action as LiveMatchesV3RepairAction,
    season,
    eventId,
    kind: kind as LiveMatchesV3RepairKind | null,
    reason,
    confirmation,
  };
}

export function assertLiveMatchesV3RepairAuthorization(
  request: Pick<LiveMatchesV3RepairRequest, 'action' | 'confirmation'>,
): void {
  if (
    request.action !== 'inspect' &&
    request.confirmation !== LIVE_MATCHES_V3_REPAIR_CONFIRMATION
  ) {
    throw new ForbiddenError(
      `write repair requires confirmation=${LIVE_MATCHES_V3_REPAIR_CONFIRMATION}`,
      'LIVE_MATCH_REPAIR_CONFIRMATION_REQUIRED',
    );
  }
}

/** Check the same current-season fence used by the checkpoint worker. */
export function assertLiveMatchesV3RepairSeason(
  action: LiveMatchesV3RepairAction,
  season: Pick<Awaited<ReturnType<typeof seasonRepository.requireByCode>>, 'isCurrent'>,
): void {
  if (action === 'replay-checkpoint' && !season.isCurrent) {
    throw new ValidationError(
      'historical Live Matches checkpoint replay cannot be enqueued on the current-season worker',
      'LIVE_MATCH_REPAIR_HISTORICAL_SEASON',
    );
  }
}

/**
 * PRE_DEADLINE is a publication lifecycle label, not the authoritative FPL
 * deadline. A queued/repair publication can still carry that label after the
 * deadline while the first fixture is waiting for kickoff. In that interval
 * the event is already the active event and a repair must be allowed to move
 * the eventless pointer. A genuinely future event must remain scoped only.
 */
export function shouldPromoteLiveMatchActiveEvent(
  state: MatchDeskRead['publication']['state'],
  deadlineTime: string | null,
  now = new Date(),
): boolean {
  if (state !== 'PRE_DEADLINE') return true;
  const deadlineMs = deadlineTime === null ? Number.NaN : Date.parse(deadlineTime);
  return Number.isFinite(deadlineMs) && deadlineMs <= now.getTime();
}

async function resolveRepairActiveEventPromotion(
  season: Awaited<ReturnType<typeof seasonRepository.requireByCode>>,
  eventId: number,
  state: MatchDeskRead['publication']['state'],
): Promise<boolean> {
  if (state !== 'PRE_DEADLINE') return true;
  const event = await eventRepository.findById(season, eventId);
  if (!event || event.deadlineTime === null || !Number.isFinite(Date.parse(event.deadlineTime))) {
    throw new ValidationError(
      'PRE_DEADLINE repair requires an authoritative event deadline',
      'LIVE_MATCH_REPAIR_EVENT_DEADLINE_MISSING',
    );
  }
  return shouldPromoteLiveMatchActiveEvent(state, event.deadlineTime);
}

function deskSummary(read: MatchDeskRead | null) {
  if (!read) return null;
  return {
    servedFrom: read.servedFrom,
    publicationId: read.publication.publicationId,
    generation: read.publication.generation,
    state: read.publication.state,
    revisions: read.publication.revisions,
    sourceCheckedAt: read.publication.sourceCheckedAt,
    publishedAt: read.publication.publishedAt,
    checkpointedAt: read.publication.checkpointedAt,
    fixtureCount: read.fixtures.length,
    payloadBytes: read.publication.desk.bytes,
    payloadSha256: read.publication.desk.sha256,
  };
}

function detailSummary(read: MatchDetailRead | null) {
  if (!read) return null;
  return {
    servedFrom: read.servedFrom,
    publicationId: read.publication.publicationId,
    generation: read.publication.generation,
    finalized: read.publication.finalized,
    observedDeskGeneration: read.publication.observedDeskGeneration,
    fixtureIdentityRevision: read.publication.fixtureIdentityRevision,
    detailRevision: read.publication.detail,
    sourceCheckedAt: read.publication.sourceCheckedAt,
    publishedAt: read.publication.publishedAt,
    checkpointedAt: read.publication.checkpointedAt,
    fixtureCount: read.fixtures.length,
    itemBytes: read.publication.fixtures.reduce((total, item) => total + item.bytes, 0),
  };
}

function sameDeskContent(left: MatchDeskRead | null, right: MatchDeskRead | null): boolean {
  return Boolean(
    left &&
      right &&
      left.publication.publicationId === right.publication.publicationId &&
      left.publication.generation === right.publication.generation &&
      left.publication.desk.sha256 === right.publication.desk.sha256 &&
      left.publication.revisions.lifecycle.revision ===
        right.publication.revisions.lifecycle.revision &&
      left.publication.revisions.fixtureIdentity.revision ===
        right.publication.revisions.fixtureIdentity.revision &&
      left.publication.revisions.scoreState.revision ===
        right.publication.revisions.scoreState.revision,
  );
}

/**
 * Compare final desk semantics while deliberately ignoring publication/storage
 * identity.  A recovery may replace a Redis generation with the durable
 * checkpoint generation, but it must never replace a different final payload.
 */
export function sameFinalLiveMatchDeskContent(
  left: MatchDeskRead | null,
  right: MatchDeskRead | null,
): boolean {
  return Boolean(
    left &&
      right &&
      left.publication.season === right.publication.season &&
      left.publication.eventId === right.publication.eventId &&
      left.publication.state === 'FINALIZED' &&
      right.publication.state === 'FINALIZED' &&
      left.publication.desk.sha256 === right.publication.desk.sha256 &&
      left.publication.desk.bytes === right.publication.desk.bytes &&
      left.publication.desk.count === right.publication.desk.count &&
      left.publication.revisions.lifecycle.revision ===
        right.publication.revisions.lifecycle.revision &&
      left.publication.revisions.fixtureIdentity.revision ===
        right.publication.revisions.fixtureIdentity.revision &&
      left.publication.revisions.scoreState.revision ===
        right.publication.revisions.scoreState.revision,
  );
}

/** Compare final detail payload/revision semantics without pointer identity. */
export function sameFinalLiveMatchDetailContent(
  left: MatchDetailRead | null,
  right: MatchDetailRead | null,
): boolean {
  if (
    !left ||
    !right ||
    left.publication.season !== right.publication.season ||
    left.publication.eventId !== right.publication.eventId ||
    !left.publication.finalized ||
    !right.publication.finalized ||
    left.publication.fixtureIdentityRevision !== right.publication.fixtureIdentityRevision ||
    left.publication.detail.revision !== right.publication.detail.revision
  ) {
    return false;
  }
  const descriptor = (read: MatchDetailRead) =>
    [...read.publication.fixtures]
      .map((item) => ({
        fixtureId: item.fixtureId,
        count: item.count,
        bytes: item.bytes,
        sha256: item.sha256,
      }))
      .sort((a, b) => a.fixtureId - b.fixtureId);
  return canonicalJson(descriptor(left)) === canonicalJson(descriptor(right));
}

function sameDetailContent(left: MatchDetailRead | null, right: MatchDetailRead | null): boolean {
  return Boolean(
    left &&
      right &&
      left.publication.publicationId === right.publication.publicationId &&
      left.publication.generation === right.publication.generation &&
      left.publication.detail.revision === right.publication.detail.revision &&
      left.publication.observedDeskGeneration === right.publication.observedDeskGeneration &&
      left.publication.fixtureIdentityRevision === right.publication.fixtureIdentityRevision,
  );
}

export function isLiveMatchDetailCompatibleWithDesk(
  detail: MatchDetailRead | null,
  desk: MatchDeskRead | null,
): boolean {
  if (!detail || !desk) return false;
  const generationCompatible =
    detail.publication.finalized || desk.publication.state === 'FINALIZED'
      ? detail.publication.observedDeskGeneration === desk.publication.generation
      : detail.publication.observedDeskGeneration <= desk.publication.generation;
  return (
    generationCompatible &&
    detail.publication.fixtureIdentityRevision ===
      desk.publication.revisions.fixtureIdentity.revision
  );
}

async function requireDetailRepairCompatibility(
  scope: { readonly season: string; readonly eventId: number },
  detail: MatchDetailRead,
  redis: Parameters<typeof readLiveMatchDeskV3>[0]['redis'],
): Promise<void> {
  const desk = await readLiveMatchDeskV3({ ...scope, redis });
  if (!isLiveMatchDetailCompatibleWithDesk(detail, desk)) {
    throw new ValidationError(
      'detail repair is incompatible with the current same-event desk publication',
      'LIVE_MATCH_REPAIR_DETAIL_INCOMPATIBLE',
    );
  }
}

async function requireDeskRepairCompatibility(
  scope: { readonly season: string; readonly eventId: number },
  desk: MatchDeskRead,
  redis: Parameters<typeof readLiveMatchDeskV3>[0]['redis'],
): Promise<MatchDetailActiveFence> {
  const detail = await readLiveMatchDetailFenceV3({ ...scope, redis });
  if (detail.read && !isLiveMatchDetailCompatibleWithDesk(detail.read, desk)) {
    throw new ValidationError(
      'desk repair would leave the current same-event detail publication incompatible',
      'LIVE_MATCH_REPAIR_DESK_INCOMPATIBLE',
    );
  }
  return detail;
}

async function inspectLiveMatchesV3Repair(request: LiveMatchesV3RepairRequest) {
  const season = await seasonRepository.requireByCode(request.season);
  const redis = await redisSingleton.getClient();
  const scope = { season: request.season, eventId: request.eventId } as const;
  const [
    deskActive,
    deskPrevious,
    detailActive,
    detailPrevious,
    deskDesired,
    detailDesired,
    deskCheckpoint,
    detailCheckpoint,
    deskActiveExists,
    deskPreviousExists,
    detailActiveExists,
    detailPreviousExists,
  ] = await Promise.all([
    readLiveMatchDeskPointerV3({ ...scope, redis }, 'active'),
    readLiveMatchDeskPointerV3({ ...scope, redis }, 'previous'),
    readLiveMatchDetailPointerV3({ ...scope, redis }, 'active'),
    readLiveMatchDetailPointerV3({ ...scope, redis }, 'previous'),
    readLiveMatchCheckpointDesiredV3({ ...scope, kind: 'desk', redis }),
    readLiveMatchCheckpointDesiredV3({ ...scope, kind: 'detail', redis }),
    readLiveMatchDeskCheckpointV3(season, request.eventId),
    readLiveMatchDetailCheckpointV3(season, request.eventId),
    redis.exists(liveMatchDeskKey(scope, 'active')),
    redis.exists(liveMatchDeskKey(scope, 'previous')),
    redis.exists(liveMatchDetailKey(scope, 'active')),
    redis.exists(liveMatchDetailKey(scope, 'previous')),
  ]);

  return {
    contractVersion: 'live-matches-v3',
    season: request.season,
    eventId: request.eventId,
    write: false,
    desk: {
      activePointerExists: deskActiveExists === 1,
      previousPointerExists: deskPreviousExists === 1,
      active: deskSummary(deskActive),
      previous: deskSummary(deskPrevious),
      checkpoint: deskSummary(deskCheckpoint),
      checkpointMatchesActive: sameDeskContent(deskActive, deskCheckpoint),
      checkpointDesired: deskDesired,
    },
    detail: {
      activePointerExists: detailActiveExists === 1,
      previousPointerExists: detailPreviousExists === 1,
      active: detailSummary(detailActive),
      previous: detailSummary(detailPrevious),
      checkpoint: detailSummary(detailCheckpoint),
      checkpointMatchesActive: sameDetailContent(detailActive, detailCheckpoint),
      checkpointDesired: detailDesired,
    },
    pairCompatible: isLiveMatchDetailCompatibleWithDesk(detailActive, deskActive),
    compatibility: {
      activeDetailWithActiveDesk: isLiveMatchDetailCompatibleWithDesk(detailActive, deskActive),
      previousDetailWithActiveDesk: isLiveMatchDetailCompatibleWithDesk(detailPrevious, deskActive),
      activeDetailWithPreviousDesk: isLiveMatchDetailCompatibleWithDesk(detailActive, deskPrevious),
      detailCheckpointWithActiveDesk: isLiveMatchDetailCompatibleWithDesk(
        detailCheckpoint,
        deskActive,
      ),
    },
  };
}

function pairRepairSummary(
  desk: MatchDeskRead | null,
  detail: MatchDetailRead | null,
): Record<string, unknown> {
  return {
    desk: deskSummary(desk),
    detail: detailSummary(detail),
  };
}

async function restoreEquivalentFinalPair(
  request: LiveMatchesV3RepairRequest,
  season: Awaited<ReturnType<typeof seasonRepository.requireByCode>>,
  redis: Parameters<typeof readLiveMatchDeskV3>[0]['redis'],
) {
  if (!season.isCurrent) {
    throw new ValidationError(
      'final pair recovery is restricted to the current season',
      'LIVE_MATCH_REPAIR_CURRENT_SEASON_REQUIRED',
    );
  }
  const [event, currentEvent] = await Promise.all([
    eventRepository.findById(season, request.eventId),
    eventRepository.findCurrent(season),
  ]);
  if (
    !event ||
    !currentEvent ||
    currentEvent.id !== request.eventId ||
    !event.finished ||
    !event.dataChecked
  ) {
    throw new ValidationError(
      'final pair recovery requires the current finished and data-checked event',
      'LIVE_MATCH_REPAIR_EVENT_NOT_FINAL',
    );
  }
  const [deskCheckpoint, detailCheckpoint, observedDesk, observedDetail] = await Promise.all([
    readLiveMatchDeskCheckpointV3(season, request.eventId),
    readLiveMatchDetailCheckpointV3(season, request.eventId),
    readLiveMatchDeskFenceV3({ season: request.season, eventId: request.eventId, redis }),
    readLiveMatchDetailFenceV3({ season: request.season, eventId: request.eventId, redis }),
  ]);
  if (
    !deskCheckpoint ||
    !detailCheckpoint ||
    deskCheckpoint.publication.state !== 'FINALIZED' ||
    !detailCheckpoint.publication.finalized ||
    !isLiveMatchDetailCompatibleWithDesk(detailCheckpoint, deskCheckpoint)
  ) {
    throw new ValidationError(
      'PostgreSQL does not contain a complete compatible final desk/detail pair',
      'LIVE_MATCH_REPAIR_FINAL_PAIR_CHECKPOINT_MISSING',
    );
  }
  const currentDesk = observedDesk.read;
  if (
    !currentDesk ||
    currentDesk.servedFrom !== 'REDIS_CURRENT' ||
    currentDesk.publication.state !== 'FINALIZED' ||
    !sameFinalLiveMatchDeskContent(currentDesk, deskCheckpoint)
  ) {
    throw new ValidationError(
      'Redis current final desk is missing or not equivalent to PostgreSQL',
      'LIVE_MATCH_REPAIR_FINAL_DESK_CONFLICT',
    );
  }
  const activeDetailPointerExists = observedDetail.observed !== '';
  const currentDetail = observedDetail.read;
  if (
    activeDetailPointerExists &&
    (!currentDetail ||
      currentDetail.servedFrom !== 'REDIS_CURRENT' ||
      !sameFinalLiveMatchDetailContent(currentDetail, detailCheckpoint))
  ) {
    throw new ValidationError(
      'Redis current detail is present but not equivalent to PostgreSQL',
      'LIVE_MATCH_REPAIR_FINAL_DETAIL_CONFLICT',
    );
  }

  const before = pairRepairSummary(currentDesk, currentDetail);
  if (
    currentDetail &&
    isLiveMatchDetailCompatibleWithDesk(currentDetail, currentDesk) &&
    sameFinalLiveMatchDetailContent(currentDetail, detailCheckpoint)
  ) {
    return {
      contractVersion: 'live-matches-v3',
      action: request.action,
      season: request.season,
      eventId: request.eventId,
      status: 'already-canonical' as const,
      before,
      after: before,
    };
  }

  const restored = await restoreLiveMatchEquivalentFinalPairV3({
    deskCheckpoint,
    detailCheckpoint,
    observedDesk,
    observedDetail,
    promoteActiveEvent: true,
    redis,
  });
  const after = pairRepairSummary(
    { publication: restored.desk, fixtures: deskCheckpoint.fixtures, servedFrom: 'REDIS_CURRENT' },
    {
      publication: restored.detail,
      fixtures: detailCheckpoint.fixtures,
      servedFrom: 'REDIS_CURRENT',
    },
  );
  return {
    contractVersion: 'live-matches-v3',
    action: request.action,
    season: request.season,
    eventId: request.eventId,
    status: restored.status,
    before,
    after,
  };
}

async function executeLiveMatchesV3Repair(request: LiveMatchesV3RepairRequest) {
  assertLiveMatchesV3RepairAuthorization(request);
  const season = await seasonRepository.requireByCode(request.season);
  assertLiveMatchesV3RepairSeason(request.action, season);
  const redis = await redisSingleton.getClient();
  const scope = { season: request.season, eventId: request.eventId } as const;

  if (request.action === 'restore-equivalent-final-pair') {
    return restoreEquivalentFinalPair(request, season, redis);
  }

  if (!request.kind) throw new ValidationError('write repairs require an exact kind');

  if (request.action === 'promote-previous') {
    let observedDetail: MatchDetailActiveFence | null = null;
    let promoteActiveEvent: boolean | undefined;
    if (request.kind === 'desk') {
      const previous = await readLiveMatchDeskPointerV3({ ...scope, redis }, 'previous');
      if (!previous) {
        throw new ValidationError(
          'no valid same-event desk previous publication is available',
          'LIVE_MATCH_REPAIR_PREVIOUS_MISSING',
        );
      }
      observedDetail = await requireDeskRepairCompatibility(scope, previous, redis);
      promoteActiveEvent = await resolveRepairActiveEventPromotion(
        season,
        request.eventId,
        previous.publication.state,
      );
    } else {
      const previous = await readLiveMatchDetailPointerV3({ ...scope, redis }, 'previous');
      if (!previous) {
        throw new ValidationError(
          'no valid same-event detail previous publication is available',
          'LIVE_MATCH_REPAIR_PREVIOUS_MISSING',
        );
      }
      await requireDetailRepairCompatibility(scope, previous, redis);
    }
    const result = await promotePreviousLiveMatchV3({
      ...scope,
      kind: request.kind,
      observedDetail,
      ...(promoteActiveEvent === undefined ? {} : { promoteActiveEvent }),
      redis,
    });
    if (result.status !== 'promoted' || !result.publication) {
      throw new ValidationError(
        `previous ${request.kind} publication was not promoted: ${result.status}`,
        'LIVE_MATCH_REPAIR_NOT_PROMOTED',
      );
    }
    return {
      contractVersion: 'live-matches-v3',
      action: request.action,
      kind: request.kind,
      season: request.season,
      eventId: request.eventId,
      status: result.status,
      publicationId: result.publication.publicationId,
      generation: result.publication.generation,
    };
  }

  if (request.action === 'rebuild-current') {
    const checkpoint =
      request.kind === 'desk'
        ? await readLiveMatchDeskCheckpointV3(season, request.eventId)
        : await readLiveMatchDetailCheckpointV3(season, request.eventId);
    if (!checkpoint) {
      throw new ValidationError(
        `no complete same-event ${request.kind} PostgreSQL checkpoint is available`,
        'LIVE_MATCH_REPAIR_CHECKPOINT_MISSING',
      );
    }
    let observedDetail: MatchDetailActiveFence | null = null;
    if (request.kind === 'desk') {
      observedDetail = await requireDeskRepairCompatibility(
        scope,
        checkpoint as MatchDeskRead,
        redis,
      );
    }
    if (request.kind === 'detail') {
      await requireDetailRepairCompatibility(scope, checkpoint as MatchDetailRead, redis);
    }
    const promoteActiveEvent =
      request.kind === 'desk'
        ? await resolveRepairActiveEventPromotion(
            season,
            request.eventId,
            (checkpoint as MatchDeskRead).publication.state,
          )
        : undefined;
    const result =
      request.kind === 'desk'
        ? await restoreLiveMatchDeskCheckpointV3({
            checkpoint: checkpoint as MatchDeskRead,
            observedDetail,
            ...(promoteActiveEvent === undefined ? {} : { promoteActiveEvent }),
            redis,
          })
        : await restoreLiveMatchDetailCheckpointV3({
            checkpoint: checkpoint as MatchDetailRead,
            redis,
          });
    return {
      contractVersion: 'live-matches-v3',
      action: request.action,
      kind: request.kind,
      season: request.season,
      eventId: request.eventId,
      published: result.published,
      publicationId: result.publication.publicationId,
      generation: result.publication.generation,
    };
  }

  if (request.action === 'replay-checkpoint') {
    const current =
      request.kind === 'desk'
        ? await readLiveMatchDeskPointerV3({ ...scope, redis }, 'active')
        : await readLiveMatchDetailPointerV3({ ...scope, redis }, 'active');
    if (!current) {
      throw new ValidationError(
        `no valid Redis current exists for exact ${request.kind} scope`,
        'LIVE_MATCH_REPAIR_CURRENT_MISSING',
      );
    }
    if (request.kind === 'detail') {
      await requireDetailRepairCompatibility(scope, current as MatchDetailRead, redis);
    }
    const desired = await setLiveMatchCheckpointDesiredV3({
      kind: request.kind,
      publication: current.publication,
      finalized:
        request.kind === 'desk'
          ? (current as MatchDeskRead).publication.state === 'FINALIZED'
          : (current as MatchDetailRead).publication.finalized,
      redis,
    });
    if (
      desired.publicationId !== current.publication.publicationId ||
      desired.generation !== current.publication.generation
    ) {
      throw new ValidationError(
        'retained checkpoint obligation does not match Redis current; refusing to supersede it',
        'LIVE_MATCH_REPAIR_REVISION_CONFLICT',
      );
    }
    await enqueueLiveMatchCheckpoint(
      season,
      request.eventId,
      request.kind,
      desired.publicationId,
      desired.generation,
    );
    return {
      contractVersion: 'live-matches-v3',
      action: request.action,
      kind: request.kind,
      season: request.season,
      eventId: request.eventId,
      publicationId: desired.publicationId,
      generation: desired.generation,
      final: desired.final,
      enqueued: true,
    };
  }

  throw new ValidationError(`unsupported Live Matches repair action: ${request.action}`);
}

/**
 * Protected operator repair entrypoint. The HTTP layer authenticates the ops
 * key; this service enforces exact scope, write confirmation, and final fences.
 */
export async function runLiveMatchesV3Repair(value: unknown) {
  const request = parseLiveMatchesV3RepairRequest(value);
  if (request.action === 'inspect') return inspectLiveMatchesV3Repair(request);
  return executeLiveMatchesV3Repair(request);
}
