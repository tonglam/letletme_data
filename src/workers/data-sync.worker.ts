import { QueueEvents, Worker } from 'bullmq';

import { dataSyncQueueName } from '../queues/data-sync.queue';
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

export function createDataSyncWorker() {
  const connection = getQueueConnection();

  const queueEvents = new QueueEvents(dataSyncQueueName, { connection });

  const worker = new Worker(
    dataSyncQueueName,
    async (job) => {
      const context = {
        jobType: 'queue' as const,
        queueName: dataSyncQueueName,
        jobId: job.id,
        jobName: job.name,
        source: job.data?.source as string | undefined,
        attempt: job.attemptsMade + 1,
      };

      logJobTriggered(context);

      return runTrackedJob(context, async () => {
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
      });
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
