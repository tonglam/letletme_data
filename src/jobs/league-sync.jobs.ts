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

    // Generate job ID for deduplication
    let jobId: string;
    if (options.tournamentId) {
      jobId = `${jobName}:${eventId}:t${options.tournamentId}`;
    } else {
      jobId = `${jobName}:${eventId}:coordinator`;
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
