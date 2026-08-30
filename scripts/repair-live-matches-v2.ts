import {
  liveMatchDeskKey,
  liveMatchDetailKey,
  promotePreviousLiveMatchV2,
  readLiveMatchCheckpointDesiredV2,
  readLiveMatchDeskPointerV2,
  readLiveMatchDetailPointerV2,
  restoreLiveMatchDeskCheckpointV2,
  restoreLiveMatchDetailCheckpointV2,
  setLiveMatchCheckpointDesiredV2,
  type MatchDeskRead,
  type MatchDetailRead,
} from '../src/cache/live-match-publication-v2';
import { redisSingleton } from '../src/cache/singleton';
import { databaseSingleton } from '../src/db/singleton';
import { enqueueLiveMatchCheckpoint } from '../src/jobs/live-data.jobs';
import { seasonRepository } from '../src/repositories/seasons';
import {
  readLiveMatchDeskCheckpointV2,
  readLiveMatchDetailCheckpointV2,
} from '../src/services/live-match-v2-checkpoint.service';

type RepairAction = 'inspect' | 'promote-previous' | 'rebuild-current' | 'replay-checkpoint';
type RepairKind = 'desk' | 'detail';

export type LiveMatchesV2RepairArguments = Readonly<{
  action: RepairAction;
  season: string;
  eventId: number;
  kind: RepairKind | null;
  reason: string | null;
}>;

function usage(): never {
  throw new Error(
    'usage: bun scripts/repair-live-matches-v2.ts --action inspect|promote-previous|rebuild-current|replay-checkpoint --season YYYY --event-id N [--kind desk|detail] [--reason text]',
  );
}

export function parseLiveMatchesRepairArguments(
  argv: readonly string[],
): LiveMatchesV2RepairArguments {
  const allowed = new Set(['action', 'season', 'event-id', 'kind', 'reason']);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) usage();
    const separator = token.indexOf('=');
    const key = token.slice(2, separator > 2 ? separator : undefined);
    if (!allowed.has(key)) throw new Error(`unsupported repair argument --${key}`);
    if (values.has(key)) throw new Error(`duplicate repair argument --${key}`);
    if (separator > 2) {
      const value = token.slice(separator + 1);
      if (!value) usage();
      values.set(key, value);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage();
    values.set(key, value);
    index += 1;
  }

  const action = values.get('action') as RepairAction | undefined;
  if (
    !action ||
    !['inspect', 'promote-previous', 'rebuild-current', 'replay-checkpoint'].includes(action)
  )
    usage();
  const season = values.get('season') ?? '';
  if (!/^\d{4}$/.test(season)) throw new Error('--season must be a four-digit season code');
  const eventId = Number(values.get('event-id'));
  if (!Number.isSafeInteger(eventId) || eventId <= 0)
    throw new Error('--event-id must be a positive integer');
  const kindValue = values.get('kind');
  const kind = kindValue === undefined ? null : (kindValue as RepairKind);
  if (kind !== null && kind !== 'desk' && kind !== 'detail')
    throw new Error('--kind must be desk or detail');
  const reason = values.get('reason')?.trim() || null;
  if (action !== 'inspect') {
    if (!kind) throw new Error('write repairs require exact --kind desk|detail');
    if (!reason || reason.length < 12)
      throw new Error('write repairs require --reason with at least 12 characters');
  }
  return { action, season, eventId, kind, reason };
}

export function assertLiveMatchesRepairAuthorization(
  action: RepairAction,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (action !== 'inspect' && environment.LIVE_MATCHES_REPAIR_CONFIRM !== 'YES') {
    throw new Error(
      'write repair refused: set LIVE_MATCHES_REPAIR_CONFIRM=YES for this exact command',
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

async function inspect(args: LiveMatchesV2RepairArguments) {
  const season = await seasonRepository.requireByCode(args.season);
  const redis = await redisSingleton.getClient();
  const scope = { season: args.season, eventId: args.eventId } as const;
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
    readLiveMatchDeskPointerV2({ ...scope, redis }, 'active'),
    readLiveMatchDeskPointerV2({ ...scope, redis }, 'previous'),
    readLiveMatchDetailPointerV2({ ...scope, redis }, 'active'),
    readLiveMatchDetailPointerV2({ ...scope, redis }, 'previous'),
    readLiveMatchCheckpointDesiredV2({ ...scope, kind: 'desk', redis }),
    readLiveMatchCheckpointDesiredV2({ ...scope, kind: 'detail', redis }),
    readLiveMatchDeskCheckpointV2(season, args.eventId),
    readLiveMatchDetailCheckpointV2(season, args.eventId),
    redis.exists(liveMatchDeskKey(scope, 'active')),
    redis.exists(liveMatchDeskKey(scope, 'previous')),
    redis.exists(liveMatchDetailKey(scope, 'active')),
    redis.exists(liveMatchDetailKey(scope, 'previous')),
  ]);

  return {
    contractVersion: 'live-matches-v2',
    season: args.season,
    eventId: args.eventId,
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
    pairCompatible: Boolean(
      deskActive &&
        detailActive &&
        detailActive.publication.observedDeskGeneration === deskActive.publication.generation &&
        detailActive.publication.fixtureIdentityRevision ===
          deskActive.publication.revisions.fixtureIdentity.revision,
    ),
  };
}

async function runRepair(args: LiveMatchesV2RepairArguments) {
  assertLiveMatchesRepairAuthorization(args.action, process.env);
  if (!args.kind) throw new Error('write repair requires an exact kind');
  const season = await seasonRepository.requireByCode(args.season);
  const redis = await redisSingleton.getClient();
  const scope = { season: args.season, eventId: args.eventId } as const;

  if (args.action === 'promote-previous') {
    const result = await promotePreviousLiveMatchV2({ ...scope, kind: args.kind, redis });
    if (result.status !== 'promoted' || !result.publication) {
      throw new Error(`previous ${args.kind} publication was not promoted: ${result.status}`);
    }
    return {
      contractVersion: 'live-matches-v2',
      action: args.action,
      kind: args.kind,
      reason: args.reason,
      season: args.season,
      eventId: args.eventId,
      status: result.status,
      publicationId: result.publication.publicationId,
      generation: result.publication.generation,
    };
  }

  if (args.action === 'rebuild-current') {
    const checkpoint =
      args.kind === 'desk'
        ? await readLiveMatchDeskCheckpointV2(season, args.eventId)
        : await readLiveMatchDetailCheckpointV2(season, args.eventId);
    if (!checkpoint)
      throw new Error(`no complete same-event ${args.kind} PostgreSQL checkpoint is available`);
    const result =
      args.kind === 'desk'
        ? await restoreLiveMatchDeskCheckpointV2({ checkpoint: checkpoint as MatchDeskRead, redis })
        : await restoreLiveMatchDetailCheckpointV2({
            checkpoint: checkpoint as MatchDetailRead,
            redis,
          });
    return {
      contractVersion: 'live-matches-v2',
      action: args.action,
      kind: args.kind,
      reason: args.reason,
      season: args.season,
      eventId: args.eventId,
      published: result.published,
      publicationId: result.publication.publicationId,
      generation: result.publication.generation,
    };
  }

  if (args.action === 'replay-checkpoint') {
    const current =
      args.kind === 'desk'
        ? await readLiveMatchDeskPointerV2({ ...scope, redis }, 'active')
        : await readLiveMatchDetailPointerV2({ ...scope, redis }, 'active');
    if (!current) throw new Error(`no valid Redis current exists for exact ${args.kind} scope`);
    const desired = await setLiveMatchCheckpointDesiredV2({
      kind: args.kind,
      publication: current.publication,
      finalized:
        args.kind === 'desk'
          ? (current as MatchDeskRead).publication.state === 'FINALIZED'
          : (current as MatchDetailRead).publication.finalized,
      redis,
    });
    if (
      desired.publicationId !== current.publication.publicationId ||
      desired.generation !== current.publication.generation
    ) {
      throw new Error(
        `retained ${args.kind} checkpoint obligation does not match Redis current; refusing to supersede it`,
      );
    }
    await enqueueLiveMatchCheckpoint(
      season,
      args.eventId,
      args.kind,
      desired.publicationId,
      desired.generation,
    );
    return {
      contractVersion: 'live-matches-v2',
      action: args.action,
      kind: args.kind,
      reason: args.reason,
      season: args.season,
      eventId: args.eventId,
      publicationId: desired.publicationId,
      generation: desired.generation,
      final: desired.final,
      enqueued: true,
    };
  }

  throw new Error(`Unsupported Live Matches V2 repair action: ${args.action}`);
}

async function main(): Promise<void> {
  const args = parseLiveMatchesRepairArguments(process.argv.slice(2));
  const result = args.action === 'inspect' ? await inspect(args) : await runRepair(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await Promise.allSettled([redisSingleton.disconnect(), databaseSingleton.disconnect()]);
  }
}
