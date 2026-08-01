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
};

async function enqueueLeagueSyncJob(
  jobName: LeagueSyncJobName,
  eventId: number,
  source: LeagueSyncJobSource = 'cron',
  options: LeagueSyncEnqueueOptions = {},
) {
  try {
    const tier = getLeagueSyncJobPriority(jobName as LeagueSyncPriorityJobName);
    const queue = getLeagueSyncQueue(tier);
    const jobData: LeagueSyncJobData = {
      eventId,
      tournamentId: options.tournamentId,
      source,
      triggeredAt: new Date().toISOString(),
    };

    // Callers may provide a deterministic ID for bounded recurring slots.
    // Other cron, manual, and cascade runs retain unique IDs.
    const runId = Date.now();
    const generatedJobId = options.tournamentId
      ? `${jobName}-e${eventId}-t${options.tournamentId}-${runId}`
      : `${jobName}-e${eventId}-coordinator-${runId}`;
    const jobId = options.jobId ?? generatedJobId;

    const job = await queue.add(jobName, jobData, {
      jobId,
      delay: options.delay,
      ...(options.jobId
        ? {
            removeOnComplete: { age: 86_400 },
            removeOnFail: { age: 172_800 },
          }
        : {}),
    });

    logInfo('League sync job enqueued', {
      jobId: job.id,
      jobName,
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
  eventId: number,
  source?: LeagueSyncJobSource,
  options?: LeagueSyncEnqueueOptions,
) => enqueueLeagueSyncJob(LEAGUE_JOBS.LEAGUE_EVENT_PICKS, eventId, source, options);

export const enqueueLeagueEventResults = (
  eventId: number,
  source?: LeagueSyncJobSource,
  options?: LeagueSyncEnqueueOptions,
) => enqueueLeagueSyncJob(LEAGUE_JOBS.LEAGUE_EVENT_RESULTS, eventId, source, options);
