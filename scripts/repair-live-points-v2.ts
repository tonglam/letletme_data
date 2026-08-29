import {
  clearLiveCheckpointDesiredV2,
  markLivePublicationCheckpointedV2,
  promotePreviousLivePublicationV2,
  readLiveCheckpointDesiredV2,
  readLivePublicationV2Pointer,
  restoreLivePublicationV2Checkpoint,
  type LivePublicationRead,
} from '../src/cache/live-publication-v2';
import { redisSingleton } from '../src/cache/singleton';
import { databaseSingleton } from '../src/db/singleton';
import { seasonRepository } from '../src/repositories/seasons';
import {
  checkpointLivePublicationV2,
  readLivePublicationV2Checkpoint,
} from '../src/services/live-publication-v2-checkpoint.service';

type RepairAction = 'inspect' | 'promote-previous' | 'rebuild-current' | 'replay-checkpoint';

export type LivePointsV2RepairArguments = {
  readonly action: RepairAction;
  readonly season: string;
  readonly eventId: number;
  readonly reason: string | null;
};

function usage(): never {
  throw new Error(
    'usage: bun scripts/repair-live-points-v2.ts --action inspect|promote-previous|rebuild-current|replay-checkpoint --season YYYY --event-id N [--reason text]',
  );
}

export function parseRepairArguments(argv: readonly string[]): LivePointsV2RepairArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) usage();
    const separator = token.indexOf('=');
    if (separator > 2) {
      values.set(token.slice(2, separator), token.slice(separator + 1));
      continue;
    }
    const key = token.slice(2);
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
  const reason = values.get('reason')?.trim() || null;
  if (action !== 'inspect' && (!reason || reason.length < 12)) {
    throw new Error('write repairs require --reason with at least 12 characters');
  }
  return { action, season, eventId, reason };
}

export function assertRepairAuthorization(
  action: RepairAction,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (action !== 'inspect' && environment.LIVE_POINTS_REPAIR_CONFIRM !== 'YES') {
    throw new Error(
      'write repair refused: set LIVE_POINTS_REPAIR_CONFIRM=YES for this exact command',
    );
  }
}

function publicationSummary(read: LivePublicationRead | null) {
  if (!read) return null;
  return {
    servedFrom: read.servedFrom,
    publicationId: read.publication.publicationId,
    generation: read.publication.generation,
    state: read.publication.state,
    sourceCheckedAt: read.publication.sourceCheckedAt,
    contentUpdatedAt: read.publication.revisions.scoreCore.contentUpdatedAt,
    publishedAt: read.publication.publishedAt,
    checkpointedAt: read.publication.checkpointedAt,
    eventLiveCount: read.eventLives.length,
    fixtureCount: read.fixtures.length,
    eventLiveSha256: read.publication.items.eventLive.sha256,
    fixturesSha256: read.publication.items.fixtures.sha256,
  };
}

async function inspect(args: LivePointsV2RepairArguments) {
  const season = await seasonRepository.requireByCode(args.season);
  const redis = await redisSingleton.getClient();
  const [active, previous, desired, checkpoint] = await Promise.all([
    readLivePublicationV2Pointer({ season: args.season, eventId: args.eventId }, 'active', redis),
    readLivePublicationV2Pointer({ season: args.season, eventId: args.eventId }, 'previous', redis),
    readLiveCheckpointDesiredV2({ season: args.season, eventId: args.eventId }, redis),
    readLivePublicationV2Checkpoint(season, args.eventId),
  ]);
  return {
    contractVersion: 'live-points-v2',
    season: args.season,
    eventId: args.eventId,
    write: false,
    active: publicationSummary(active),
    previous: publicationSummary(previous),
    checkpoint: publicationSummary(checkpoint),
    checkpointDesired: desired,
  };
}

async function runRepair(args: LivePointsV2RepairArguments) {
  assertRepairAuthorization(args.action, process.env);
  const season = await seasonRepository.requireByCode(args.season);
  const scope = { season: args.season, eventId: args.eventId } as const;
  const redis = await redisSingleton.getClient();

  if (args.action === 'promote-previous') {
    const result = await promotePreviousLivePublicationV2(scope, redis);
    return {
      contractVersion: 'live-points-v2',
      action: args.action,
      reason: args.reason,
      season: args.season,
      eventId: args.eventId,
      ...result,
      publication: result.publication
        ? {
            publicationId: result.publication.publicationId,
            generation: result.publication.generation,
          }
        : null,
    };
  }

  if (args.action === 'rebuild-current') {
    const checkpoint = await readLivePublicationV2Checkpoint(season, args.eventId);
    if (!checkpoint)
      throw new Error('no complete same-event V2 PostgreSQL checkpoint is available');
    const result = await restoreLivePublicationV2Checkpoint({ checkpoint, redis });
    return {
      contractVersion: 'live-points-v2',
      action: args.action,
      reason: args.reason,
      season: args.season,
      eventId: args.eventId,
      published: result.published,
      publicationId: result.publication.publicationId,
      generation: result.publication.generation,
    };
  }

  const current = await readLivePublicationV2Pointer(scope, 'active', redis);
  if (!current)
    throw new Error('no complete V2 Redis current publication is available to checkpoint');
  const checkpointed = await checkpointLivePublicationV2({
    season,
    eventId: args.eventId,
    publication: current.publication,
    eventLives: current.eventLives,
    fixtures: current.fixtures,
  });
  if (checkpointed) {
    const marked = await markLivePublicationCheckpointedV2(current.publication, new Date(), redis);
    if (!marked)
      throw new Error(
        'PostgreSQL checkpoint committed but Redis CAS mark failed; obligation remains for reconciliation',
      );
    const desired = await readLiveCheckpointDesiredV2(scope, redis);
    if (
      desired &&
      desired.publicationId === current.publication.publicationId &&
      desired.generation === current.publication.generation
    ) {
      await clearLiveCheckpointDesiredV2(desired, redis);
    }
  }
  return {
    contractVersion: 'live-points-v2',
    action: args.action,
    reason: args.reason,
    season: args.season,
    eventId: args.eventId,
    checkpointed,
    publicationId: current.publication.publicationId,
    generation: current.publication.generation,
  };
}

async function main(): Promise<void> {
  const args = parseRepairArguments(process.argv.slice(2));
  if (args.action === 'inspect') {
    process.stdout.write(`${JSON.stringify(await inspect(args), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await runRepair(args), null, 2)}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await Promise.allSettled([redisSingleton.disconnect(), databaseSingleton.disconnect()]);
  }
}
