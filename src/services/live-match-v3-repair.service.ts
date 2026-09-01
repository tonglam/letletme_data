import {
  liveMatchDeskKey,
  liveMatchDetailKey,
  promotePreviousLiveMatchV3,
  readLiveMatchCheckpointDesiredV3,
  readLiveMatchDeskV3,
  readLiveMatchDeskPointerV3,
  readLiveMatchDetailPointerV3,
  restoreLiveMatchDeskCheckpointV3,
  restoreLiveMatchDetailCheckpointV3,
  setLiveMatchCheckpointDesiredV3,
  type MatchDeskRead,
  type MatchDetailRead,
} from '../cache/live-match-publication-v3';
import { redisSingleton } from '../cache/singleton';
import { enqueueLiveMatchCheckpoint } from '../jobs/live-data.jobs';
import { seasonRepository } from '../repositories/seasons';
import {
  readLiveMatchDeskCheckpointV3,
  readLiveMatchDetailCheckpointV3,
} from './live-match-v3-checkpoint.service';
import { ForbiddenError, ValidationError } from '../utils/errors';

export const LIVE_MATCHES_V3_REPAIR_CONFIRMATION = 'LIVE_MATCHES_V3_REPAIR';

export type LiveMatchesV3RepairAction =
  | 'inspect'
  | 'promote-previous'
  | 'rebuild-current'
  | 'replay-checkpoint';
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
      'action must be inspect, promote-previous, rebuild-current, or replay-checkpoint',
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
  const kind = rawKind === undefined || rawKind === null ? null : optionalString(rawKind, 'kind');
  if (kind !== null && !REPAIR_KINDS.has(kind as LiveMatchesV3RepairKind)) {
    invalidRequest('kind must be desk or detail');
  }
  const reason = optionalString(record.reason, 'reason');
  if (action !== 'inspect') {
    if (kind === null) invalidRequest('write repairs require an exact desk or detail kind');
    if (reason === null || reason.length < 12) {
      invalidRequest('write repairs require a reason with at least 12 characters');
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

async function executeLiveMatchesV3Repair(request: LiveMatchesV3RepairRequest) {
  assertLiveMatchesV3RepairAuthorization(request);
  if (!request.kind) throw new ValidationError('write repairs require an exact kind');
  const season = await seasonRepository.requireByCode(request.season);
  assertLiveMatchesV3RepairSeason(request.action, season);
  const redis = await redisSingleton.getClient();
  const scope = { season: request.season, eventId: request.eventId } as const;

  if (request.action === 'promote-previous') {
    if (request.kind === 'detail') {
      const previous = await readLiveMatchDetailPointerV3({ ...scope, redis }, 'previous');
      if (!previous) {
        throw new ValidationError(
          'no valid same-event detail previous publication is available',
          'LIVE_MATCH_REPAIR_PREVIOUS_MISSING',
        );
      }
      await requireDetailRepairCompatibility(scope, previous, redis);
    }
    const result = await promotePreviousLiveMatchV3({ ...scope, kind: request.kind, redis });
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
    if (request.kind === 'detail') {
      await requireDetailRepairCompatibility(scope, checkpoint as MatchDetailRead, redis);
    }
    const result =
      request.kind === 'desk'
        ? await restoreLiveMatchDeskCheckpointV3({ checkpoint: checkpoint as MatchDeskRead, redis })
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
