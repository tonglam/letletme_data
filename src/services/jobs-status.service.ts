import { Queue } from 'bullmq';

import { readActiveDataPublication } from '../cache/data-publication';
import { seasonRepository } from '../repositories/seasons';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { allQueueNames } from '../queues/names';
import { getQueueConnection } from '../utils/queue';
import { checkRuntimeHeartbeat, readRuntimeHeartbeat } from '../utils/runtime-heartbeat';
import { schedulerObligationSummary } from '../repositories/scheduler-obligations';
import { schedulerRegistry } from '../scheduler/job-registry';
import { eventRepository } from '../repositories/events';

export async function getJobsStatus(): Promise<Record<string, unknown>> {
  const season = await seasonRepository.findCurrent();
  const [obligations, schedulerHeartbeat, queueWorkerHeartbeat, contentWorkerHeartbeat] =
    await Promise.all([
      schedulerObligationSummary(),
      readRuntimeHeartbeat('scheduler'),
      readRuntimeHeartbeat('queueWorker'),
      readRuntimeHeartbeat('contentWorker'),
    ]);
  const scheduler = Boolean(schedulerHeartbeat && (await checkRuntimeHeartbeat('scheduler')));
  const queueWorker = Boolean(queueWorkerHeartbeat && (await checkRuntimeHeartbeat('queueWorker')));
  const contentWorker = Boolean(
    contentWorkerHeartbeat && (await checkRuntimeHeartbeat('contentWorker')),
  );
  const publicationConsistency: Record<string, boolean> = {};
  const currentEvent = await eventRepository.findCurrent(season);
  const publicationScopes = [
    { dataset: 'fpl:core' as const },
    { dataset: 'fpl:market' as const },
    ...(currentEvent ? [{ dataset: 'fpl:live' as const, eventId: currentEvent.id }] : []),
  ];
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
    const key = scope.eventId === undefined ? scope.dataset : `${scope.dataset}:e${scope.eventId}`;
    publicationConsistency[key] =
      Boolean(dbActive) === Boolean(redisActive) &&
      (!dbActive ||
        !redisActive ||
        (dbActive.publicationId === redisActive.manifest.publicationId &&
          dbActive.revision === redisActive.manifest.revision));
  }

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
    },
    obligations,
    publicationConsistency,
    queues,
  };
}
