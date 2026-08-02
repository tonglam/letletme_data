import { getDataSyncJobPriority, type DataSyncPriorityJobName } from '../domain/job-priority';
import { getDataSyncQueue, type DataSyncJobName } from '../queues/data-sync.queue';
import { logError, logInfo } from '../utils/logger';
import { formatCronDateKey } from '../utils/timezone';

export type DataSyncJobSource = 'cron' | 'manual' | 'api' | 'event-transition' | 'cascade';

export interface DataSyncEnqueueOptions {
  jobId?: string;
  eventId?: number;
  changeDate?: string;
  /** When true (default for explicit jobId), remove job on settle so re-triggers work. */
  removeOnSettle?: boolean;
}

function defaultDataSyncJobId(
  jobName: DataSyncJobName,
  source: DataSyncJobSource,
  options: DataSyncEnqueueOptions,
): string | undefined {
  // API/manual triggers dedupe in the waiting room; cron stays unique per tick.
  if (source !== 'api' && source !== 'manual') {
    return undefined;
  }
  const eventPart = options.eventId !== undefined ? `-e${options.eventId}` : '';
  const datePart = options.changeDate !== undefined ? `-${options.changeDate}` : '';
  return `${jobName}${eventPart}${datePart}-${source}`;
}

async function enqueueDataSyncJob(
  jobName: DataSyncJobName,
  source: DataSyncJobSource = 'cron',
  options: DataSyncEnqueueOptions = {},
) {
  try {
    const tier = getDataSyncJobPriority(jobName as DataSyncPriorityJobName);
    const queue = getDataSyncQueue(tier);
    const jobId = options.jobId ?? defaultDataSyncJobId(jobName, source, options);
    const hasDeterministicId = jobId !== undefined;
    const removeOnSettle = options.removeOnSettle ?? hasDeterministicId;
    const job = await queue.add(
      jobName,
      {
        source,
        triggeredAt: new Date().toISOString(),
        ...(options.eventId !== undefined ? { eventId: options.eventId } : {}),
        ...(options.changeDate !== undefined ? { changeDate: options.changeDate } : {}),
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60_000,
        },
        jobId,
        ...(removeOnSettle ? { removeOnComplete: true, removeOnFail: true } : {}),
      },
    );

    logInfo('Data sync job enqueued', {
      jobId: job.id,
      jobName,
      source,
      tier,
      queue: queue.name,
    });

    return job;
  } catch (error) {
    const tier = getDataSyncJobPriority(jobName as DataSyncPriorityJobName);
    logError('Failed to enqueue data sync job', error, { jobName, source, tier });
    throw error;
  }
}

export const enqueueEventsSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('events', source);

export const enqueueFixturesSyncJob = (
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) => enqueueDataSyncJob('fixtures', source, options);

/** Full GW1–38 fixtures backfill with per-gameweek error isolation. */
export const enqueueFixturesAllGameweeksSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('fixtures-all-gameweeks', source);

export const enqueueTeamsSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('teams', source);

export const enqueuePlayersSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('players', source);

export const enqueuePlayerPricesSyncJob = (
  source: DataSyncJobSource,
  options: DataSyncEnqueueOptions & { changeDate: string },
) => enqueueDataSyncJob('player-prices', source, options);

export const enqueuePlayerStatsSyncJob = (
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) => enqueueDataSyncJob('player-stats', source, options);

export const enqueuePhasesSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('phases', source);

export const enqueuePlayerValuesSyncJob = (
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) =>
  enqueueDataSyncJob('player-values', source, {
    ...options,
    changeDate: options?.changeDate ?? formatCronDateKey(),
  });
