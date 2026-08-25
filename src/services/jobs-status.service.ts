import { Queue } from 'bullmq';

import {
  readActiveDataPublication,
  type DataPublicationDeliveryItem,
  type DataPublicationManifest,
  type DataPublicationReadResult,
} from '../cache/data-publication';
import { loadDataPublicationDelivery } from '../repositories/data-publication-outbox';
import {
  PRICE_CHANGE_DATASET,
  PRICE_CHANGE_MAX_AGE_MS,
  PRICE_CHANGE_READY_MS,
} from './price-change-predictions.service';
import { seasonRepository } from '../repositories/seasons';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { allQueueNames } from '../queues/names';
import { getQueueConnection } from '../utils/queue';
import { checkRuntimeHeartbeat, readRuntimeHeartbeat } from '../utils/runtime-heartbeat';
import {
  schedulerObligationStatus,
  schedulerObligationSummary,
} from '../repositories/scheduler-obligations';
import { getSchedulerLaneTargets, listSchedulerLanes } from '../repositories/scheduler-lanes';
import { schedulerRegistry } from '../scheduler/job-registry';
import { eventRepository } from '../repositories/events';
import { getMyFplSnapshotOperationalStatus } from './my-fpl-snapshot-publication.service';

type ActivePublication = Readonly<{ publicationId: string; revision: number }>;
type PublicationDelivery = Readonly<{
  manifest: DataPublicationManifest;
  items: readonly DataPublicationDeliveryItem[];
}>;

type PriceChangeContextSelection = Readonly<{
  context: Record<string, unknown> | null;
  publicationId: string | null;
  source: 'redis' | 'database' | 'none';
}>;

function asContext(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readDeliveryContext(delivery: PublicationDelivery | null): Record<string, unknown> | null {
  const contextItem = delivery?.items.find((item) => item.manifest.name === 'context');
  if (!contextItem) return null;
  try {
    return asContext(JSON.parse(contextItem.payload));
  } catch {
    return null;
  }
}

function redisMatchesActivePublication(
  dbActive: ActivePublication | null,
  redisActive: Pick<DataPublicationReadResult, 'manifest'> | null,
): boolean {
  return Boolean(
    dbActive &&
      redisActive &&
      redisActive.manifest.publicationId === dbActive.publicationId &&
      redisActive.manifest.revision === dbActive.revision,
  );
}

export function selectCanonicalPriceChangeContext(input: {
  dbActive: ActivePublication | null;
  redisActive: DataPublicationReadResult | null;
  dbDelivery: PublicationDelivery | null;
}): PriceChangeContextSelection {
  if (redisMatchesActivePublication(input.dbActive, input.redisActive)) {
    return {
      context: asContext(input.redisActive?.items.context),
      publicationId: input.dbActive?.publicationId ?? null,
      source: 'redis',
    };
  }

  const databaseContext =
    input.dbActive &&
    input.dbDelivery?.manifest.dataset === PRICE_CHANGE_DATASET &&
    input.dbDelivery.manifest.publicationId === input.dbActive.publicationId &&
    input.dbDelivery.manifest.revision === input.dbActive.revision
      ? readDeliveryContext(input.dbDelivery)
      : null;
  if (databaseContext) {
    return {
      context: databaseContext,
      publicationId: input.dbActive?.publicationId ?? null,
      source: 'database',
    };
  }

  return {
    context: null,
    publicationId: input.dbActive?.publicationId ?? null,
    source: 'none',
  };
}

export async function getJobsStatus(): Promise<Record<string, unknown>> {
  const season = await seasonRepository.findCurrent();
  const [
    obligations,
    schedulerHeartbeat,
    queueWorkerHeartbeat,
    contentWorkerHeartbeat,
    mediaWorkerHeartbeat,
    myFplSnapshots,
  ] = await Promise.all([
    schedulerObligationSummary(),
    readRuntimeHeartbeat('scheduler'),
    readRuntimeHeartbeat('queueWorker'),
    readRuntimeHeartbeat('contentWorker'),
    readRuntimeHeartbeat('mediaWorker'),
    getMyFplSnapshotOperationalStatus(season),
  ]);
  const scheduler = Boolean(schedulerHeartbeat && (await checkRuntimeHeartbeat('scheduler')));
  const queueWorker = Boolean(queueWorkerHeartbeat && (await checkRuntimeHeartbeat('queueWorker')));
  const contentWorker = Boolean(
    contentWorkerHeartbeat && (await checkRuntimeHeartbeat('contentWorker')),
  );
  const mediaWorker = Boolean(mediaWorkerHeartbeat && (await checkRuntimeHeartbeat('mediaWorker')));
  const publicationConsistency: Record<string, boolean> = {};
  const currentEvent = await eventRepository.findCurrent(season);
  const publicationScopes = [
    { dataset: 'fpl:core' as const },
    { dataset: 'fpl:market' as const },
    { dataset: PRICE_CHANGE_DATASET },
    ...(currentEvent ? [{ dataset: 'fpl:live' as const, eventId: currentEvent.id }] : []),
  ];
  let priceChangeDbActive: Awaited<
    ReturnType<typeof syncOperationsRepository.findActivePublication>
  > = null;
  let priceChangeRedisActive: Awaited<ReturnType<typeof readActiveDataPublication>> = null;
  for (const scope of publicationScopes) {
    const dbActive = await syncOperationsRepository.findActivePublication(
      scope.dataset,
      season,
      scope.eventId,
    );
    const redisActive = await readActiveDataPublication({
      dataset: scope.dataset,
      seasonCode: season.seasonCode,
      ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
    });
    if (scope.dataset === PRICE_CHANGE_DATASET) {
      priceChangeDbActive = dbActive;
      priceChangeRedisActive = redisActive;
    }
    const key = scope.eventId === undefined ? scope.dataset : `${scope.dataset}:e${scope.eventId}`;
    publicationConsistency[key] =
      Boolean(dbActive) === Boolean(redisActive) &&
      (!dbActive ||
        !redisActive ||
        (dbActive.publicationId === redisActive.manifest.publicationId &&
          dbActive.revision === redisActive.manifest.revision));
  }

  const priceChangeRedisMatches = redisMatchesActivePublication(
    priceChangeDbActive,
    priceChangeRedisActive,
  );
  const priceChangeDbDelivery =
    priceChangeDbActive && !priceChangeRedisMatches
      ? await loadDataPublicationDelivery(priceChangeDbActive.publicationId).catch(() => null)
      : null;
  const priceChangeSelection = selectCanonicalPriceChangeContext({
    dbActive: priceChangeDbActive,
    redisActive: priceChangeRedisActive,
    dbDelivery: priceChangeDbDelivery,
  });
  const priceChangeContext = priceChangeSelection.context;
  const fetchedAtValue =
    typeof priceChangeContext?.fetchedAt === 'string' ? priceChangeContext.fetchedAt : null;
  const fetchedAtMs = fetchedAtValue ? Date.parse(fetchedAtValue) : Number.NaN;
  const ageMs = Number.isFinite(fetchedAtMs) ? Math.max(0, Date.now() - fetchedAtMs) : null;
  const priceChangeStatus =
    ageMs === null
      ? 'UNAVAILABLE'
      : ageMs < PRICE_CHANGE_READY_MS
        ? 'READY'
        : ageMs <= PRICE_CHANGE_MAX_AGE_MS
          ? 'STALE'
          : 'UNAVAILABLE';
  const priceChangeObligation = await schedulerObligationStatus({
    jobName: 'price-change-predictions',
    scopeKey: season.seasonCode,
  }).catch(() => ({
    latest: null,
    overdue: false,
    consecutiveUnsuccessfulCycles: 0,
  }));
  const priceChanges = {
    dataset: PRICE_CHANGE_DATASET,
    revision: priceChangeSelection.publicationId,
    fetchedAt: fetchedAtValue,
    ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
    expectedPlayerCount:
      typeof priceChangeContext?.expectedPlayerCount === 'number'
        ? priceChangeContext.expectedPlayerCount
        : 0,
    observedPlayerCount:
      typeof priceChangeContext?.observedPlayerCount === 'number'
        ? priceChangeContext.observedPlayerCount
        : 0,
    status: priceChangeStatus,
    dbRedisParity: publicationConsistency[PRICE_CHANGE_DATASET] ?? false,
    overdue: priceChangeObligation.overdue,
    consecutiveUnsuccessfulCycles: priceChangeObligation.consecutiveUnsuccessfulCycles,
    schedulerObligation: {
      name: 'price-change-predictions',
      cadence: schedulerRegistry.find(
        (definition) => definition.name === 'price-change-predictions',
      )?.cadence,
      criticality: schedulerRegistry.find(
        (definition) => definition.name === 'price-change-predictions',
      )?.criticality,
      latest: priceChangeObligation.latest,
      summary: obligations,
    },
  };

  const connection = getQueueConnection();
  const queues = await Promise.all(
    allQueueNames.map(async (name) => {
      const queue = new Queue(name, { connection });
      try {
        return {
          name,
          counts: await queue.getJobCounts(
            'waiting',
            'paused',
            'active',
            'delayed',
            'prioritized',
            'completed',
            'failed',
          ),
        };
      } finally {
        await queue.close();
      }
    }),
  );
  const schedulerLanes = await Promise.all(
    (await listSchedulerLanes()).map(async (lane) => {
      const targets = await getSchedulerLaneTargets({ laneId: lane.laneId });
      const queue = new Queue(lane.queueName, { connection });
      let bullState: string | null = null;
      let bullTimestamp: number | null = null;
      try {
        if (lane.bullJobId) {
          const job = await queue.getJob(lane.bullJobId);
          bullState = job ? await job.getState() : 'missing';
          bullTimestamp = job?.timestamp ?? null;
        }
      } finally {
        await queue.close();
      }
      // The lane stores the immutable scheduled waterline. Obligation.dueAt
      // may be moved by retry/backoff and must not redefine the period.
      const desiredDueAt = lane.desiredDueAt;
      return {
        laneId: lane.laneId,
        laneKey: lane.laneKey,
        jobName: lane.jobName,
        scopeKey: lane.scopeKey,
        queueName: lane.queueName,
        state: lane.state,
        desiredPeriod: targets?.desired?.periodKey ?? null,
        desiredDueAt: desiredDueAt.toISOString(),
        activePeriod: targets?.active?.periodKey ?? null,
        bullJobId: lane.bullJobId,
        bullState,
        waitingMs: bullTimestamp === null ? null : Math.max(0, Date.now() - bullTimestamp),
        lastProgressAt: lane.lastProgressAt.toISOString(),
        progressAgeMs: Math.max(0, Date.now() - lane.lastProgressAt.getTime()),
        publicationLagMs: ageMs,
        generation: lane.dispatchGeneration,
        supersededCount: lane.supersededCount,
        blockerJobId: lane.blockerJobId,
        retryNotBefore: lane.retryNotBefore?.toISOString() ?? null,
        lastError: lane.lastError,
      };
    }),
  );
  return {
    generatedAt: new Date().toISOString(),
    season: season.seasonCode,
    registry: schedulerRegistry.map((definition) => ({
      name: definition.name,
      cadence: definition.cadence,
      timezone: definition.timezone,
      catchUpPolicy: definition.catchUpPolicy,
      criticality: definition.criticality,
      queueName: definition.queueName,
      executionPolicy: definition.executionPolicy?.kind ?? null,
      successPredicate: definition.successPredicate,
    })),
    runtime: {
      scheduler: { healthy: scheduler, heartbeat: schedulerHeartbeat },
      queueWorker: { healthy: queueWorker, heartbeat: queueWorkerHeartbeat },
      contentWorker: { healthy: contentWorker, heartbeat: contentWorkerHeartbeat },
      mediaWorker: { healthy: mediaWorker, heartbeat: mediaWorkerHeartbeat },
    },
    obligations,
    myFplSnapshots,
    publicationConsistency,
    priceChanges,
    schedulerLanes,
    queues,
  };
}
