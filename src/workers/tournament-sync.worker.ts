import { Worker, Job } from 'bullmq';

import {
  tournamentSyncQueueName,
  TOURNAMENT_JOBS,
  type TournamentSyncJobData,
} from '../queues/tournament-sync.queue';
import { syncTournamentEventResults } from '../services/tournament-event-results.service';
import { syncTournamentPointsRaceResults } from '../services/tournament-points-race-results.service';
import { syncTournamentBattleRaceResults } from '../services/tournament-battle-race-results.service';
import { syncTournamentKnockoutResults } from '../services/tournament-knockout-results.service';
import {
  syncTournamentEventTransfersPost,
  syncTournamentEventTransfersPre,
} from '../services/tournament-event-transfers.service';
import { syncTournamentEventCupResults } from '../services/tournament-event-cup-results.service';
import { syncTournamentEventPicks } from '../services/tournament-event-picks.service';
import { syncTournamentInfo } from '../services/tournament-info.service';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import {
  enqueueTournamentPointsRace,
  enqueueTournamentBattleRace,
  enqueueTournamentKnockout,
  enqueueTournamentTransfersPost,
  enqueueTournamentCupResults,
} from '../jobs/tournament-sync.jobs';

/**
 * Enqueue cascade jobs after tournament-event-results completes
 * These jobs depend on fresh tournament event results
 */
async function enqueueTournamentCascade(eventId: number) {
  logInfo('Enqueueing tournament cascade jobs', { eventId });

  try {
    // Enqueue all dependent jobs to run in parallel
    const results = await Promise.allSettled([
      enqueueTournamentPointsRace(eventId, 'cascade'),
      enqueueTournamentBattleRace(eventId, 'cascade'),
      enqueueTournamentKnockout(eventId, 'cascade'),
      enqueueTournamentTransfersPost(eventId, 'cascade'),
      enqueueTournamentCupResults(eventId, 'cascade'),
    ]);

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    logInfo('Tournament cascade jobs enqueued', {
      eventId,
      total: results.length,
      successful,
      failed,
    });

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const jobNames = [
          'points-race',
          'battle-race',
          'knockout',
          'transfers-post',
          'cup-results',
        ];
        logError('Failed to enqueue cascade job', result.reason, {
          eventId,
          jobName: jobNames[index],
        });
      }
    });
  } catch (error) {
    logError('Failed to enqueue tournament cascade jobs', error, { eventId });
    throw error;
  }
}

/**
 * Tournament Sync Worker
 *
 * Processes tournament sync jobs:
 * - Base job (event-results): Triggers cascade on completion
 * - Cascade jobs: Run in parallel after base completes
 * - Independent jobs: Run on separate schedule
 *
 * Architecture:
 * event-results (base) → [points-race, battle-race, knockout, transfers-post, cup-results] (parallel)
 */
export const tournamentSyncWorker = new Worker<TournamentSyncJobData>(
  tournamentSyncQueueName,
  async (job: Job<TournamentSyncJobData>) => {
    const { eventId, source } = job.data;

    logInfo('Processing tournament sync job', {
      jobId: job.id,
      jobName: job.name,
      eventId,
      source,
      attempt: job.attemptsMade + 1,
    });

    try {
      switch (job.name) {
        case TOURNAMENT_JOBS.EVENT_RESULTS:
          // Base job: sync results then trigger cascade
          await syncTournamentEventResults(eventId);
          await enqueueTournamentCascade(eventId);
          break;

        case TOURNAMENT_JOBS.POINTS_RACE:
          await syncTournamentPointsRaceResults(eventId);
          break;

        case TOURNAMENT_JOBS.BATTLE_RACE:
          await syncTournamentBattleRaceResults(eventId);
          break;

        case TOURNAMENT_JOBS.KNOCKOUT:
          await syncTournamentKnockoutResults(eventId);
          break;

        case TOURNAMENT_JOBS.TRANSFERS_POST:
          await syncTournamentEventTransfersPost(eventId);
          break;

        case TOURNAMENT_JOBS.CUP_RESULTS:
          await syncTournamentEventCupResults(eventId);
          break;

        case TOURNAMENT_JOBS.EVENT_PICKS:
          await syncTournamentEventPicks(eventId);
          break;

        case TOURNAMENT_JOBS.TRANSFERS_PRE:
          await syncTournamentEventTransfersPre(eventId);
          break;

        case TOURNAMENT_JOBS.INFO:
          await syncTournamentInfo();
          break;

        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }

      logInfo('Tournament sync job completed', {
        jobId: job.id,
        jobName: job.name,
        eventId,
        attempt: job.attemptsMade + 1,
      });
    } catch (error) {
      logError('Tournament sync job failed', error, {
        jobId: job.id,
        jobName: job.name,
        eventId,
        attempt: job.attemptsMade + 1,
      });
      throw error;
    }
  },
  {
    connection: getQueueConnection(),
    concurrency: 10, // Process up to 10 jobs in parallel
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
);

tournamentSyncWorker.on('completed', (job) => {
  logInfo('Tournament sync worker completed job', {
    jobId: job.id,
    jobName: job.name,
    eventId: job.data.eventId,
  });
});

tournamentSyncWorker.on('failed', (job, err) => {
  logError('Tournament sync worker failed job', err, {
    jobId: job?.id,
    jobName: job?.name,
    eventId: job?.data.eventId,
  });
});

tournamentSyncWorker.on('error', (err) => {
  logError('Tournament sync worker error', err);
});
