import { QueueEvents, Worker } from 'bullmq';

import { dataSyncQueueName } from '../queues/data-sync.queue';
import { syncEvents } from '../services/events.service';
import { syncFixtures } from '../services/fixtures.service';
import { syncPhases } from '../services/phases.service';
import { syncPlayers } from '../services/players.service';
import { syncCurrentPlayerStats } from '../services/player-stats.service';
import { syncCurrentPlayerValues } from '../services/player-values.service';
import { syncTeams } from '../services/teams.service';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';

export function createDataSyncWorker() {
  const connection = getQueueConnection();

  const queueEvents = new QueueEvents(dataSyncQueueName, { connection });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logError('Queue event failed', failedReason, { queue: dataSyncQueueName, jobId });
  });

  queueEvents.on('completed', ({ jobId }) => {
    logInfo('Queue event completed', { queue: dataSyncQueueName, jobId });
  });

  queueEvents
    .waitUntilReady()
    .then(() => logInfo('Queue events ready', { queue: dataSyncQueueName }))
    .catch((error) => logError('Queue events init failed', error, { queue: dataSyncQueueName }));

  const worker = new Worker(
    dataSyncQueueName,
    async (job) => {
      const startedAt = Date.now();
      logInfo('Data sync job received', {
        jobId: job.id,
        name: job.name,
        source: job.data?.source,
      });

      const finished = async <T>(fn: () => Promise<T>) => {
        try {
          const result = await fn();
          const finishedAt = Date.now();
          logInfo('Data sync job finished', {
            jobId: job.id,
            name: job.name,
            durationMs: finishedAt - startedAt,
            result,
          });
          return result;
        } catch (error) {
          const finishedAt = Date.now();
          logError('Data sync job failed', error, {
            jobId: job.id,
            name: job.name,
            durationMs: finishedAt - startedAt,
          });
          throw error;
        }
      };

      switch (job.name) {
        case 'events':
          return finished(() => syncEvents());
        case 'fixtures':
          return finished(() => syncFixtures());
        case 'teams':
          return finished(() => syncTeams());
        case 'players':
          return finished(() => syncPlayers());
        case 'player-stats':
          return finished(() => syncCurrentPlayerStats());
        case 'phases':
          return finished(() => syncPhases());
        case 'player-values':
          return finished(() => syncCurrentPlayerValues());
        default:
          throw new Error(`Unknown data-sync job: ${job.name}`);
      }
    },
    { connection },
  );

  worker.on('completed', (job) => {
    logInfo('Data sync job completed', { jobId: job.id, name: job.name });
  });

  worker.on('failed', (job, error) => {
    logError('Data sync job failed', error, {
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
    });
  });

  return { worker, queueEvents };
}
