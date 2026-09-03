import { randomUUID } from 'node:crypto';
import type { FplSeasonRef } from '../domain/fpl-season';

import { leagueSyncQueue } from '../queues/league-sync.queue';
import {
  LEAGUE_JOBS,
  isLeagueSyncJobName,
  validateLeagueSyncJobData,
  type LeagueSyncJobName,
  type LeagueSyncJobData,
} from '../queues/league-sync-job-contract';
import { ValidationError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';

export type LeagueSyncJobSource = 'cron' | 'manual' | 'cascade' | 'catchup' | 'reconcile';

export type LeagueSyncEnqueueOptions = {
  tournamentId?: number;
  delay?: number;
  jobId?: string;
  runId?: string;
  obligationId?: string;
  obligationGeneration?: number;
  /** Exact freshness window being repaired. */
  freshnessWindowId?: number;
  freshAfter?: string;
};

export function buildLeagueSyncJobData(
  season: FplSeasonRef,
  eventId: number,
  source: LeagueSyncJobSource,
  options: LeagueSyncEnqueueOptions,
): LeagueSyncJobData {
  const runId = options.runId ?? randomUUID();
  return validateLeagueSyncJobData({
    seasonId: season.seasonId,
    seasonCode: season.seasonCode,
    eventId,
    tournamentId: options.tournamentId,
    source,
    triggeredAt: new Date().toISOString(),
    runId,
    ...(options.obligationId === undefined ? {} : { obligationId: options.obligationId }),
    ...(options.obligationGeneration === undefined
      ? {}
      : { obligationGeneration: options.obligationGeneration }),
    ...(options.freshnessWindowId === undefined
      ? {}
      : { freshnessWindowId: options.freshnessWindowId }),
    ...(options.freshAfter === undefined ? {} : { freshAfter: options.freshAfter }),
  });
}

async function enqueueLeagueSyncJob(
  jobName: LeagueSyncJobName,
  season: FplSeasonRef,
  eventId: number,
  source: LeagueSyncJobSource = 'cron',
  options: LeagueSyncEnqueueOptions = {},
) {
  try {
    if (!isLeagueSyncJobName(jobName)) {
      throw new ValidationError('League sync job name is invalid.', 'INVALID_LEAGUE_SYNC_JOB');
    }
    // Validate before Redis admission and before constructing an e<eventId>
    // job identity. TypeScript annotations cannot protect runtime callers.
    const jobData = buildLeagueSyncJobData(season, eventId, source, options);
    const queue = leagueSyncQueue;
    if (await isQueueDrainOnly(queue.name)) {
      throw new QueueDrainOnlyError(queue.name);
    }

    // Callers may provide a deterministic ID for bounded recurring slots.
    // Other cron, manual, and cascade runs retain unique IDs.
    const jobNonce = Date.now();
    const generatedJobId = options.tournamentId
      ? `${jobName}-${season.seasonCode}-e${eventId}-t${options.tournamentId}-${jobNonce}`
      : `${jobName}-${season.seasonCode}-e${eventId}-coordinator-${jobNonce}`;
    const jobId = options.jobId ? `${season.seasonCode}-${options.jobId}` : generatedJobId;

    const manualCleanup = source === 'manual';
    const job = await queue.add(jobName, jobData, {
      jobId,
      delay: options.delay,
      ...(options.jobId
        ? {
            removeOnComplete: manualCleanup ? true : BULL_COMPLETED_RETENTION,
            removeOnFail: manualCleanup ? true : BULL_FAILED_RETENTION,
          }
        : {}),
    });

    logInfo('League sync job enqueued', {
      jobId: job.id,
      jobName,
      runId: job.data?.runId ?? jobData.runId,
      eventId,
      tournamentId: options.tournamentId,
      source,
      queue: queue.name,
    });

    return job;
  } catch (error) {
    logError('Failed to enqueue league sync job', error, {
      jobName,
      eventId,
      tournamentId: options.tournamentId,
      source,
    });
    throw error;
  }
}

export const enqueueLeagueEventPicks = (
  season: FplSeasonRef,
  eventId: number,
  source?: LeagueSyncJobSource,
  options?: LeagueSyncEnqueueOptions,
) => enqueueLeagueSyncJob(LEAGUE_JOBS.LEAGUE_EVENT_PICKS, season, eventId, source, options);

export const enqueueLeagueEventResults = (
  season: FplSeasonRef,
  eventId: number,
  source?: LeagueSyncJobSource,
  options?: LeagueSyncEnqueueOptions,
) => enqueueLeagueSyncJob(LEAGUE_JOBS.LEAGUE_EVENT_RESULTS, season, eventId, source, options);
