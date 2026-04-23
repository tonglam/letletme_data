import { QueueEvents, Worker, type Job } from 'bullmq';

import { MUTATION_PRIORITY_ORDER } from '../domain/job-priority';
import {
  type DataSyncJobData,
  dataSyncQueuesByTier,
  getDataSyncQueueName,
  isDataSyncTieredQueueEnabled,
} from '../queues/data-sync.queue';
import { syncEvents } from '../services/events.service';
import { syncFixtures } from '../services/fixtures.service';
import { syncPhases } from '../services/phases.service';
import { syncPlayers } from '../services/players.service';
import { syncCurrentPlayerStats } from '../services/player-stats.service';
import { syncCurrentPlayerValues } from '../services/player-values.service';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { syncTeams } from '../services/teams.service';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { startStrictPriorityGate } from './strict-priority-gate';
import type { WorkerRuntime } from './worker-runtime';

const processDataSyncJob = async (job: Job<DataSyncJobData>) => {
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data?.source as string | undefined,
    attempt: job.attemptsMade + 1,
  };

  logJobTriggered(context);

  return withMutationConflictGuard(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
    },
    () =>
      runTrackedJob(context, async () => {
        switch (job.name) {
          case 'events':
            return syncEvents();
          case 'fixtures':
            return syncFixtures();
          case 'teams':
            return syncTeams();
          case 'players':
            return syncPlayers();
          case 'player-stats':
            return syncCurrentPlayerStats();
          case 'phases':
            return syncPhases();
          case 'player-values':
            return syncCurrentPlayerValues();
          default:
            throw new Error(`Unknown data-sync job: ${job.name}`);
        }
      }),
  );
};

export function createDataSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const activeTiers = isDataSyncTieredQueueEnabled ? MUTATION_PRIORITY_ORDER : (['p1'] as const);
  const workers: Worker<DataSyncJobData>[] = [];
  const queueEvents: QueueEvents[] = [];
  const monitorTargets: WorkerRuntime['monitorTargets'] = [];

  for (const tier of activeTiers) {
    const queueName = getDataSyncQueueName(tier);
    const worker = new Worker<DataSyncJobData>(queueName, processDataSyncJob, { connection });
    const events = new QueueEvents(queueName, { connection });

    worker.on('completed', (job) => {
      logInfo('Data sync job completed', { jobId: job.id, name: job.name, tier });
    });

    worker.on('failed', (job, error) => {
      logError('Data sync job failed', error, {
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        tier,
      });
    });

    workers.push(worker);
    queueEvents.push(events);
    monitorTargets.push({
      queue: dataSyncQueuesByTier[tier],
      queueEvents: events,
      queueName,
      tier,
    });
  }

  const gate = startStrictPriorityGate(
    'data-sync',
    {
      p0: { queue: dataSyncQueuesByTier.p0, worker: workersByTier(workers, activeTiers, 'p0') },
      p1: { queue: dataSyncQueuesByTier.p1, worker: workersByTier(workers, activeTiers, 'p1') },
      p2: { queue: dataSyncQueuesByTier.p2, worker: workersByTier(workers, activeTiers, 'p2') },
      p3: { queue: dataSyncQueuesByTier.p3, worker: workersByTier(workers, activeTiers, 'p3') },
    },
    { enabled: isDataSyncTieredQueueEnabled },
  );

  return { workers, queueEvents, monitorTargets, stop: gate.stop };
}

function workersByTier(
  workers: Worker<DataSyncJobData>[],
  activeTiers: readonly string[],
  tier: 'p0' | 'p1' | 'p2' | 'p3',
) {
  const index = activeTiers.indexOf(tier);
  if (index >= 0) {
    return workers[index];
  }
  return workers[0];
}
