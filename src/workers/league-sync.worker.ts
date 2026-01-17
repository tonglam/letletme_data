import { Worker, Job } from 'bullmq';

import {
  leagueSyncQueueName,
  LEAGUE_JOBS,
  type LeagueSyncJobData,
} from '../queues/league-sync.queue';
import { syncLeagueEventPicksByTournament } from '../services/league-event-picks.service';
import { syncLeagueEventResultsByTournament } from '../services/league-event-results.service';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { enqueueLeagueEventPicks, enqueueLeagueEventResults } from '../jobs/league-sync.jobs';

/**
 * Enqueue per-tournament jobs for league event picks
 * Coordinator pattern: one job per tournament
 */
async function enqueuePicksPerTournament(eventId: number) {
  logInfo('Enqueueing per-tournament picks jobs', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments for picks sync', { eventId });
    return { enqueued: 0 };
  }

  const results = await Promise.allSettled(
    tournaments.map((tournament) =>
      enqueueLeagueEventPicks(eventId, 'cascade', { tournamentId: tournament.id }),
    ),
  );

  const successful = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  logInfo('Per-tournament picks jobs enqueued', {
    eventId,
    total: tournaments.length,
    successful,
    failed,
  });

  // Log any failures
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logError('Failed to enqueue picks job for tournament', result.reason, {
        eventId,
        tournamentId: tournaments[index].id,
      });
    }
  });

  return { enqueued: successful };
}

/**
 * Enqueue per-tournament jobs for league event results
 * Coordinator pattern: one job per tournament
 */
async function enqueueResultsPerTournament(eventId: number) {
  logInfo('Enqueueing per-tournament results jobs', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments for results sync', { eventId });
    return { enqueued: 0 };
  }

  const results = await Promise.allSettled(
    tournaments.map((tournament) =>
      enqueueLeagueEventResults(eventId, 'cascade', { tournamentId: tournament.id }),
    ),
  );

  const successful = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  logInfo('Per-tournament results jobs enqueued', {
    eventId,
    total: tournaments.length,
    successful,
    failed,
  });

  // Log any failures
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logError('Failed to enqueue results job for tournament', result.reason, {
        eventId,
        tournamentId: tournaments[index].id,
      });
    }
  });

  return { enqueued: successful };
}

/**
 * League Sync Worker
 *
 * Processes league sync jobs:
 * - Coordinator job (no tournamentId): Enqueues one job per tournament
 * - Tournament job (with tournamentId): Processes that specific tournament
 *
 * Benefits:
 * - Parallelization: Multiple tournaments can process concurrently
 * - Failure isolation: One tournament failure doesn't block others
 * - Retry per tournament: Failed tournaments retry independently
 */
export const leagueSyncWorker = new Worker<LeagueSyncJobData>(
  leagueSyncQueueName,
  async (job: Job<LeagueSyncJobData>) => {
    const { eventId, tournamentId, source } = job.data;

    logInfo('Processing league sync job', {
      jobId: job.id,
      jobName: job.name,
      eventId,
      tournamentId,
      source,
      attempt: job.attemptsMade + 1,
    });

    try {
      switch (job.name) {
        case LEAGUE_JOBS.LEAGUE_EVENT_PICKS:
          if (tournamentId) {
            // Process specific tournament
            const result = await syncLeagueEventPicksByTournament(tournamentId, eventId);
            return result;
          } else {
            // Coordinator: enqueue per-tournament jobs
            const result = await enqueuePicksPerTournament(eventId);
            return result;
          }

        case LEAGUE_JOBS.LEAGUE_EVENT_RESULTS:
          if (tournamentId) {
            // Process specific tournament
            const result = await syncLeagueEventResultsByTournament(tournamentId, eventId);
            return result;
          } else {
            // Coordinator: enqueue per-tournament jobs
            const result = await enqueueResultsPerTournament(eventId);
            return result;
          }

        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    } catch (error) {
      logError('League sync job failed', error, {
        jobId: job.id,
        jobName: job.name,
        eventId,
        tournamentId,
        attempt: job.attemptsMade + 1,
      });
      throw error;
    } finally {
      logInfo('League sync job completed', {
        jobId: job.id,
        jobName: job.name,
        eventId,
        tournamentId,
      });
    }
  },
  {
    connection: getQueueConnection(),
    concurrency: 10, // Process up to 10 tournaments in parallel
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
);

leagueSyncWorker.on('completed', (job) => {
  logInfo('League sync worker completed job', {
    jobId: job.id,
    jobName: job.name,
    eventId: job.data.eventId,
    tournamentId: job.data.tournamentId,
  });
});

leagueSyncWorker.on('failed', (job, err) => {
  logError('League sync worker failed job', err, {
    jobId: job?.id,
    jobName: job?.name,
    eventId: job?.data.eventId,
    tournamentId: job?.data.tournamentId,
  });
});

leagueSyncWorker.on('error', (err) => {
  logError('League sync worker error', err);
});
