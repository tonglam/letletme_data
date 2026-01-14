import { QueueEvents, Worker } from 'bullmq';

import { entryInfos } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { entrySyncQueueName, type EntrySyncJobData } from '../queues/entry-sync.queue';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
  type EntrySyncJobSource,
} from '../jobs/entry-sync.queue';
import {
  syncEntryEventPicks,
  syncEntryEventResults,
  syncEntryEventTransfers,
  syncEntryInfo,
} from '../services/entries.service';
import { logError, logInfo } from '../utils/logger';
import { getQueueConnection } from '../utils/queue';

const maxRetryCycles = 2;

async function loadEntryIds(entryIds?: number[]): Promise<number[]> {
  if (entryIds && entryIds.length > 0) {
    return entryIds;
  }

  const db = await getDb();
  const rows = await db.select({ id: entryInfos.id }).from(entryInfos);
  return rows.map((row) => row.id);
}

async function syncEntries(
  label: string,
  entryIds: number[],
  handler: (entryId: number) => Promise<unknown>,
): Promise<{ total: number; success: number; failed: number; failedIds: number[] }> {
  logInfo(`Found entries for ${label}`, { count: entryIds.length });

  let success = 0;
  let failed = 0;
  const failedIds: number[] = [];

  for (const entryId of entryIds) {
    try {
      await handler(entryId);
      success += 1;
    } catch (error) {
      failed += 1;
      failedIds.push(entryId);
      logError(`${label} failed for entry`, error, { entryId });
    }
  }

  return { total: entryIds.length, success, failed, failedIds };
}

async function scheduleRetry(
  jobName: 'entry-info' | 'entry-picks' | 'entry-transfers' | 'entry-results',
  source: EntrySyncJobSource | undefined,
  failedIds: number[],
  retryCount: number,
) {
  switch (jobName) {
    case 'entry-info':
      return enqueueEntryInfoSyncJob(source, { entryIds: failedIds, retryCount });
    case 'entry-picks':
      return enqueueEntryPicksSyncJob(source, { entryIds: failedIds, retryCount });
    case 'entry-transfers':
      return enqueueEntryTransfersSyncJob(source, { entryIds: failedIds, retryCount });
    case 'entry-results':
      return enqueueEntryResultsSyncJob(source, { entryIds: failedIds, retryCount });
  }
}

async function handleEntryJob(
  jobName: 'entry-info' | 'entry-picks' | 'entry-transfers' | 'entry-results',
  label: string,
  handler: (entryId: number) => Promise<unknown>,
  jobData?: EntrySyncJobData,
) {
  const entryIds = await loadEntryIds(jobData?.entryIds);
  const result = await syncEntries(label, entryIds, handler);

  if (result.failedIds.length > 0) {
    const retryCount = (jobData?.retryCount ?? 0) + 1;
    if (retryCount <= maxRetryCycles) {
      const retryJob = await scheduleRetry(jobName, jobData?.source, result.failedIds, retryCount);
      logInfo('Entry sync retry enqueued', {
        jobName,
        retryCount,
        failed: result.failedIds.length,
        jobId: retryJob?.id,
      });
    } else {
      logError('Entry sync retry limit reached', new Error('Entry sync retries exhausted'), {
        jobName,
        retryCount,
        failed: result.failedIds.length,
      });
    }
  }

  return result;
}

export function createEntrySyncWorker() {
  const connection = getQueueConnection();

  const queueEvents = new QueueEvents(entrySyncQueueName, { connection });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logError('Queue event failed', failedReason, { queue: entrySyncQueueName, jobId });
  });

  queueEvents.on('completed', ({ jobId }) => {
    logInfo('Queue event completed', { queue: entrySyncQueueName, jobId });
  });

  queueEvents
    .waitUntilReady()
    .then(() => logInfo('Queue events ready', { queue: entrySyncQueueName }))
    .catch((error) => logError('Queue events init failed', error, { queue: entrySyncQueueName }));

  const worker = new Worker(
    entrySyncQueueName,
    async (job) => {
      const startedAt = Date.now();
      logInfo('Entry sync job received', {
        jobId: job.id,
        name: job.name,
        source: job.data?.source,
      });

      const finished = async <T>(fn: () => Promise<T>) => {
        try {
          const result = await fn();
          const finishedAt = Date.now();
          logInfo('Entry sync job finished', {
            jobId: job.id,
            name: job.name,
            durationMs: finishedAt - startedAt,
            result,
          });
          return result;
        } catch (error) {
          const finishedAt = Date.now();
          logError('Entry sync job failed', error, {
            jobId: job.id,
            name: job.name,
            durationMs: finishedAt - startedAt,
          });
          throw error;
        }
      };

      switch (job.name) {
        case 'entry-info':
          return finished(() =>
            handleEntryJob('entry-info', 'entry info sync', syncEntryInfo, job.data),
          );
        case 'entry-picks':
          return finished(() =>
            handleEntryJob('entry-picks', 'entry picks sync', syncEntryEventPicks, job.data),
          );
        case 'entry-transfers':
          return finished(() =>
            handleEntryJob(
              'entry-transfers',
              'entry transfers sync',
              syncEntryEventTransfers,
              job.data,
            ),
          );
        case 'entry-results':
          return finished(() =>
            handleEntryJob('entry-results', 'entry results sync', syncEntryEventResults, job.data),
          );
        default:
          throw new Error(`Unknown entry-sync job: ${job.name}`);
      }
    },
    { connection },
  );

  worker.on('completed', (job) => {
    logInfo('Entry sync job completed', { jobId: job.id, name: job.name });
  });

  worker.on('failed', (job, error) => {
    logError('Entry sync job failed', error, {
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
    });
  });

  return { worker, queueEvents };
}
