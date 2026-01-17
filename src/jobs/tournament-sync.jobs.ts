import {
  tournamentSyncQueue,
  TOURNAMENT_JOBS,
  type TournamentSyncJobName,
  type TournamentSyncJobData,
} from '../queues/tournament-sync.queue';
import { logError, logInfo } from '../utils/logger';

export type TournamentSyncJobSource = 'cron' | 'manual' | 'cascade';

async function enqueueTournamentSyncJob(
  jobName: TournamentSyncJobName,
  eventId: number,
  source: TournamentSyncJobSource = 'cron',
  options: { delay?: number } = {},
) {
  try {
    const jobData: TournamentSyncJobData = {
      eventId,
      source,
      triggeredAt: new Date().toISOString(),
    };

    // Generate job ID for deduplication (cannot use : separator in BullMQ)
    const jobId = `${jobName}-e${eventId}`;

    const job = await tournamentSyncQueue.add(jobName, jobData, {
      jobId,
      delay: options.delay,
    });

    logInfo('Tournament sync job enqueued', {
      jobId: job.id,
      jobName,
      eventId,
      source,
    });

    return job;
  } catch (error) {
    logError('Failed to enqueue tournament sync job', error, {
      jobName,
      eventId,
      source,
    });
    throw error;
  }
}

// Base job (triggers cascade)
export const enqueueTournamentEventResults = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.EVENT_RESULTS, eventId, source);

// Cascade jobs
export const enqueueTournamentPointsRace = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.POINTS_RACE, eventId, source);

export const enqueueTournamentBattleRace = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.BATTLE_RACE, eventId, source);

export const enqueueTournamentKnockout = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.KNOCKOUT, eventId, source);

export const enqueueTournamentTransfersPost = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.TRANSFERS_POST, eventId, source);

export const enqueueTournamentCupResults = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.CUP_RESULTS, eventId, source);

// Independent jobs
export const enqueueTournamentEventPicks = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.EVENT_PICKS, eventId, source);

export const enqueueTournamentTransfersPre = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.TRANSFERS_PRE, eventId, source);

export const enqueueTournamentInfo = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.INFO, eventId, source);
