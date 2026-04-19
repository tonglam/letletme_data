import {
  leagueSyncQueue,
  LEAGUE_JOBS,
  type LeagueSyncJobName,
  type LeagueSyncJobData,
} from '../queues/league-sync.queue';
import { logError, logInfo } from '../utils/logger';

export type LeagueSyncJobSource = 'cron' | 'manual' | 'cascade';

async function enqueueLeagueSyncJob(
  jobName: LeagueSyncJobName,
  eventId: number,
  source: LeagueSyncJobSource = 'cron',
  options: { tournamentId?: number; delay?: number } = {},
) {
  try {
    const jobData: LeagueSyncJobData = {
      eventId,
      tournamentId: options.tournamentId,
      source,
      triggeredAt: new Date().toISOString(),
    };

    // Use unique IDs so cron/cascade runs for the same event are not deduped
    // while completed jobs are still retained in BullMQ.
    const runId = Date.now();
    let jobId: string;
    if (options.tournamentId) {
      jobId = `${jobName}-e${eventId}-t${options.tournamentId}-${runId}`;
    } else {
      jobId = `${jobName}-e${eventId}-coordinator-${runId}`;
    }

    const job = await leagueSyncQueue.add(jobName, jobData, {
      jobId,
      delay: options.delay,
    });

    logInfo('League sync job enqueued', {
      jobId: job.id,
      jobName,
      eventId,
      tournamentId: options.tournamentId,
      source,
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
  eventId: number,
  source?: LeagueSyncJobSource,
  options?: { tournamentId?: number },
) => enqueueLeagueSyncJob(LEAGUE_JOBS.LEAGUE_EVENT_PICKS, eventId, source, options);

export const enqueueLeagueEventResults = (
  eventId: number,
  source?: LeagueSyncJobSource,
  options?: { tournamentId?: number },
) => enqueueLeagueSyncJob(LEAGUE_JOBS.LEAGUE_EVENT_RESULTS, eventId, source, options);
