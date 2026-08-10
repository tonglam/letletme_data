import { randomUUID } from 'node:crypto';
import type { FplSeasonRef } from '../domain/fpl-season';

import {
  getLeagueSyncQueue,
  LEAGUE_JOBS,
  type LeagueSyncJobName,
  type LeagueSyncJobData,
} from '../queues/league-sync.queue';
import { getLeagueSyncJobPriority, type LeagueSyncPriorityJobName } from '../domain/job-priority';
import { logError, logInfo } from '../utils/logger';

export type LeagueSyncJobSource = 'cron' | 'manual' | 'cascade';

export type LeagueSyncEnqueueOptions = {
  tournamentId?: number;
  delay?: number;
  jobId?: string;
  runId?: string;
};

async function enqueueLeagueSyncJob(
  jobName: LeagueSyncJobName,
  season: FplSeasonRef,
  eventId: number,
  source: LeagueSyncJobSource = 'cron',
  options: LeagueSyncEnqueueOptions = {},
) {
  try {
    const tier = getLeagueSyncJobPriority(jobName as LeagueSyncPriorityJobName);
    const queue = getLeagueSyncQueue(tier);
    const runId = options.runId ?? randomUUID();
    const jobData: LeagueSyncJobData = {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      eventId,
      tournamentId: options.tournamentId,
      source,
      triggeredAt: new Date().toISOString(),
      runId,
    };

    // Callers may provide a deterministic ID for bounded recurring slots.
    // Other cron, manual, and cascade runs retain unique IDs.
    const jobNonce = Date.now();
    const generatedJobId = options.tournamentId
      ? `${jobName}-${season.seasonCode}-e${eventId}-t${options.tournamentId}-${jobNonce}`
      : `${jobName}-${season.seasonCode}-e${eventId}-coordinator-${jobNonce}`;
    const jobId = options.jobId ? `${season.seasonCode}-${options.jobId}` : generatedJobId;

    const job = await queue.add(jobName, jobData, {
      jobId,
      delay: options.delay,
      ...(options.jobId
        ? {
            removeOnComplete: { age: 86_400 },
            removeOnFail: true,
          }
        : {}),
    });

    logInfo('League sync job enqueued', {
      jobId: job.id,
      jobName,
      runId: job.data?.runId ?? runId,
      eventId,
      tournamentId: options.tournamentId,
      source,
      tier,
      queue: queue.name,
    });

    return job;
  } catch (error) {
    const tier = getLeagueSyncJobPriority(jobName as LeagueSyncPriorityJobName);
    logError('Failed to enqueue league sync job', error, {
      jobName,
      eventId,
      tournamentId: options.tournamentId,
      source,
      tier,
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
