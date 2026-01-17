import { QueueEvents, Worker } from 'bullmq';
import { asc } from 'drizzle-orm';

import { entryInfos } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import {
  entrySyncQueueName,
  type EntrySyncJobData,
  type EntrySyncJobSource,
  type EntrySyncJobName,
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE,
  ENTRY_SYNC_DEFAULT_CONCURRENCY,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS,
} from '../queues/entry-sync.queue';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
  type EntrySyncJobOptions,
} from '../jobs/entry-sync.queue';
import { syncEntryInfo } from '../services/entry-info.service';
import {
  syncEntryEventPicks,
  syncEntryEventResults,
  syncEntryEventTransfers,
} from '../services/entries.service';
import { logError, logInfo } from '../utils/logger';
import { getQueueConnection } from '../utils/queue';

const maxRetryCycles = 2;
const retryBaseDelayMs = 5 * 60_000;
const retryMaxDelayMs = 30 * 60_000;

interface LoadedEntryIds {
  entryIds: number[];
  hasMore: boolean;
  nextOffset: number;
  chunkSize: number;
  chunkOffset: number;
  fetchedFromDb: boolean;
}

interface SyncEntriesOptions {
  concurrency: number;
  throttleMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadEntryIds(jobData?: EntrySyncJobData): Promise<LoadedEntryIds> {
  const chunkSize = jobData?.chunkSize ?? ENTRY_SYNC_DEFAULT_CHUNK_SIZE;
  const chunkOffset = jobData?.chunkOffset ?? 0;

  if (jobData?.entryIds && jobData.entryIds.length > 0) {
    return {
      entryIds: jobData.entryIds,
      hasMore: false,
      nextOffset: chunkOffset + jobData.entryIds.length,
      chunkSize,
      chunkOffset,
      fetchedFromDb: false,
    };
  }

  const db = await getDb();
  const rows = await db
    .select({ id: entryInfos.id })
    .from(entryInfos)
    .orderBy(asc(entryInfos.id))
    .limit(chunkSize)
    .offset(chunkOffset);

  const ids = rows.map((row) => row.id);
  return {
    entryIds: ids,
    hasMore: ids.length === chunkSize,
    nextOffset: chunkOffset + ids.length,
    chunkSize,
    chunkOffset,
    fetchedFromDb: true,
  };
}

async function syncEntries(
  label: string,
  entryIds: number[],
  handler: (entryId: number) => Promise<unknown>,
  options: SyncEntriesOptions,
): Promise<{ total: number; success: number; failed: number; failedIds: number[] }> {
  if (entryIds.length === 0) {
    return { total: 0, success: 0, failed: 0, failedIds: [] };
  }

  logInfo(`Found entries for ${label}`, {
    count: entryIds.length,
    concurrency: options.concurrency,
  });

  let success = 0;
  let failed = 0;
  const failedIds: number[] = [];
  let index = 0;
  const workerCount = Math.max(1, Math.min(options.concurrency, entryIds.length));

  const runWorker = async () => {
    while (index < entryIds.length) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= entryIds.length) {
        break;
      }
      const entryId = entryIds[currentIndex];
      try {
        await handler(entryId);
        success += 1;
      } catch (error) {
        failed += 1;
        failedIds.push(entryId);
        logError(`${label} failed for entry`, error, { entryId });
      }

      if (options.throttleMs > 0) {
        await sleep(options.throttleMs);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));

  return { total: entryIds.length, success, failed, failedIds };
}

async function enqueueEntryJob(
  jobName: EntrySyncJobName,
  source: EntrySyncJobSource | undefined,
  options: EntrySyncJobOptions,
) {
  switch (jobName) {
    case 'entry-info':
      return enqueueEntryInfoSyncJob(source, options);
    case 'entry-picks':
      return enqueueEntryPicksSyncJob(source, options);
    case 'entry-transfers':
      return enqueueEntryTransfersSyncJob(source, options);
    case 'entry-results':
      return enqueueEntryResultsSyncJob(source, options);
  }
}

async function scheduleRetry(
  jobName: EntrySyncJobName,
  jobData: EntrySyncJobData | undefined,
  failedIds: number[],
  retryCount: number,
) {
  const delayMultiplier = Math.max(retryCount, 1);
  const delayMs = Math.min(retryBaseDelayMs * delayMultiplier, retryMaxDelayMs);

  return enqueueEntryJob(jobName, jobData?.source, {
    entryIds: failedIds,
    retryCount,
    concurrency: jobData?.concurrency,
    throttleMs: jobData?.throttleMs,
    delayMs,
    eventId: jobData?.eventId,
  });
}

async function handleEntryJob(
  jobName: EntrySyncJobName,
  label: string,
  handler: (entryId: number) => Promise<unknown>,
  jobData?: EntrySyncJobData,
) {
  const loaded = await loadEntryIds(jobData);
  if (loaded.entryIds.length === 0) {
    logInfo(`No entries found for ${label}`, {
      jobName,
      chunkOffset: loaded.chunkOffset,
    });
    return { total: 0, success: 0, failed: 0, failedIds: [] };
  }

  const concurrency = jobData?.concurrency ?? ENTRY_SYNC_DEFAULT_CONCURRENCY;
  const throttleMs = jobData?.throttleMs ?? ENTRY_SYNC_DEFAULT_THROTTLE_MS;

  const result = await syncEntries(label, loaded.entryIds, handler, {
    concurrency,
    throttleMs,
  });

  if (!jobData?.entryIds && loaded.fetchedFromDb && loaded.hasMore) {
    const nextOffset = loaded.nextOffset;
    const nextJob = await enqueueEntryJob(jobName, jobData?.source, {
      chunkOffset: nextOffset,
      chunkSize: loaded.chunkSize,
      concurrency,
      throttleMs,
      eventId: jobData?.eventId,
    });
    logInfo('Entry sync next chunk enqueued', {
      jobName,
      nextOffset,
      jobId: nextJob?.id,
    });
  }

  if (result.failedIds.length > 0) {
    const retryCount = (jobData?.retryCount ?? 0) + 1;
    if (retryCount <= maxRetryCycles) {
      const retryJob = await scheduleRetry(jobName, jobData, result.failedIds, retryCount);
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
            handleEntryJob(
              'entry-picks',
              'entry picks sync',
              (entryId) => syncEntryEventPicks(entryId, job.data?.eventId),
              job.data,
            ),
          );
        case 'entry-transfers':
          return finished(() =>
            handleEntryJob(
              'entry-transfers',
              'entry transfers sync',
              (entryId) => syncEntryEventTransfers(entryId, job.data?.eventId),
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
