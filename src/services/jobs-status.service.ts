import { Queue } from 'bullmq';

import { readActiveDataPublication } from '../cache/data-publication';
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
import { schedulerRegistry } from '../scheduler/job-registry';
import { eventRepository } from '../repositories/events';
import { getMyFplSnapshotOperationalStatus } from './my-fpl-snapshot-publication.service';

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

  let priceChangeContext: Record<string, unknown> | null = null;
  if (
    priceChangeRedisActive?.items.context &&
    typeof priceChangeRedisActive.items.context === 'object'
  ) {
    priceChangeContext = priceChangeRedisActive.items.context as Record<string, unknown>;
  } else if (priceChangeDbActive) {
    const delivery = await loadDataPublicationDelivery(priceChangeDbActive.publicationId).catch(
      () => null,
    );
    const contextItem = delivery?.items.find((item) => item.manifest.name === 'context');
    if (contextItem) {
      try {
        const parsed = JSON.parse(contextItem.payload) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          priceChangeContext = parsed as Record<string, unknown>;
        }
      } catch {
        priceChangeContext = null;
      }
    }
  }
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
    revision:
      priceChangeRedisActive?.manifest.publicationId ?? priceChangeDbActive?.publicationId ?? null,
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
    queues,
  };
}
