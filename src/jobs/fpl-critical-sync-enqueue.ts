import type { FplSeasonRef } from '../domain/fpl-season';
import {
  fplCriticalSyncQueue,
  type FplCriticalJobName,
  type FplCriticalJobData,
} from '../queues/fpl-critical-sync.queue';
import { logError, logInfo } from '../utils/logger';
import { trackQueueRunJob } from '../services/queue-run-tracker';
import {
  createDataSyncJobData,
  getExplicitDataSyncQueueJobId,
  type DataSyncEnqueueOptions,
  type DataSyncJobSource,
} from './data-sync-job-definition';

export type FplCriticalEnqueueOptions = DataSyncEnqueueOptions & {
  laneId: string;
  laneGeneration: number;
  blockerLaneId?: string;
};

async function enqueueFplCriticalJob(
  season: FplSeasonRef,
  name: FplCriticalJobName,
  source: DataSyncJobSource,
  options: FplCriticalEnqueueOptions,
) {
  try {
    const jobData = createDataSyncJobData(season, source, options) as FplCriticalJobData;
    const jobId = getExplicitDataSyncQueueJobId(
      season,
      options.jobId ?? `${name}-${options.laneId}`,
    );
    const removeOnSettle = source === 'manual' && (options.removeOnSettle ?? true);
    const job = await fplCriticalSyncQueue.add(name, jobData, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      ...(removeOnSettle ? { removeOnComplete: true, removeOnFail: true } : {}),
    });
    logInfo('FPL critical sync job enqueued', {
      queue: fplCriticalSyncQueue.name,
      jobId: job.id,
      name,
      laneId: options.laneId,
      laneGeneration: options.laneGeneration,
      runId: job.data.runId,
    });
    // Queue insertion is the delivery authority. A reporting/tracker write
    // must not turn a successful deterministic Bull add into a second
    // generation after the dispatch lease expires.
    await trackQueueRunJob(job.data.runId, fplCriticalSyncQueue.name, job.id).catch((error) => {
      logError('Failed to attach FPL critical queue run tracker', error, {
        queue: fplCriticalSyncQueue.name,
        jobId: job.id,
        name,
      });
    });
    return job;
  } catch (error) {
    logError('Failed to enqueue FPL critical sync job', error, {
      queue: fplCriticalSyncQueue.name,
      name,
      laneId: options.laneId,
    });
    throw error;
  }
}

export function enqueueFplCriticalPriceChangeJob(
  season: FplSeasonRef,
  source: DataSyncJobSource,
  options: FplCriticalEnqueueOptions,
) {
  return enqueueFplCriticalJob(season, 'price-change-predictions', source, options);
}

export function enqueueFplCriticalCoreRepairJob(
  season: FplSeasonRef,
  source: DataSyncJobSource,
  options: FplCriticalEnqueueOptions,
) {
  return enqueueFplCriticalJob(season, 'core-snapshot-price-change-repair', source, options);
}
