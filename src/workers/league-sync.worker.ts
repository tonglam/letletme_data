import { Worker, Job, QueueEvents } from 'bullmq';

import { MUTATION_PRIORITY_ORDER, type MutationPriorityTier } from '../domain/job-priority';
import {
  getLeagueSyncQueueName,
  isLeagueSyncTieredQueueEnabled,
  leagueSyncQueuesByTier,
  LEAGUE_JOBS,
  type LeagueSyncJobData,
} from '../queues/league-sync.queue';
import { syncLeagueEventPicksByTournament } from '../services/league-event-picks.service';
import { syncLeagueEventResultsByTournament } from '../services/league-event-results.service';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { enqueueLeagueEventPicks, enqueueLeagueEventResults } from '../jobs/league-sync.jobs';
import { startStrictPriorityGate } from './strict-priority-gate';
import type { WorkerRuntime } from './worker-runtime';

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
async function processLeagueSyncJob(job: Job<LeagueSyncJobData>) {
  const { eventId, tournamentId, source } = job.data;
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    eventId,
    source,
    attempt: job.attemptsMade + 1,
    tournamentId,
  };

  logJobTriggered(context);

  return withMutationConflictGuard(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
      eventId,
      tournamentId,
    },
    () =>
      runTrackedJob(context, async () => {
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
      }),
  );
}

export function createLeagueSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const activeTiers = isLeagueSyncTieredQueueEnabled ? MUTATION_PRIORITY_ORDER : (['p3'] as const);
  const workers: Worker<LeagueSyncJobData>[] = [];
  const queueEvents: QueueEvents[] = [];
  const monitorTargets: WorkerRuntime['monitorTargets'] = [];

  for (const tier of activeTiers) {
    const queueName = getLeagueSyncQueueName(tier);
    const worker = new Worker<LeagueSyncJobData>(queueName, processLeagueSyncJob, {
      connection,
      concurrency: 10,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
    });
    const events = new QueueEvents(queueName, { connection });

    worker.on('completed', (job) => {
      logInfo('League sync worker completed job', {
        jobId: job.id,
        jobName: job.name,
        eventId: job.data.eventId,
        tournamentId: job.data.tournamentId,
        tier,
      });
    });

    worker.on('failed', (job, err) => {
      logError('League sync worker failed job', err, {
        jobId: job?.id,
        jobName: job?.name,
        eventId: job?.data.eventId,
        tournamentId: job?.data.tournamentId,
        tier,
      });
    });

    worker.on('error', (err) => {
      logError('League sync worker error', err, { tier });
    });

    workers.push(worker);
    queueEvents.push(events);
    monitorTargets.push({
      queue: leagueSyncQueuesByTier[tier],
      queueEvents: events,
      queueName,
      tier,
    });
  }

  const workerByTier = buildWorkerTierMap(workers, activeTiers);
  const gate = startStrictPriorityGate(
    'league-sync',
    {
      p0: { queue: leagueSyncQueuesByTier.p0, worker: workerByTier.p0 },
      p1: { queue: leagueSyncQueuesByTier.p1, worker: workerByTier.p1 },
      p2: { queue: leagueSyncQueuesByTier.p2, worker: workerByTier.p2 },
      p3: { queue: leagueSyncQueuesByTier.p3, worker: workerByTier.p3 },
    },
    { enabled: isLeagueSyncTieredQueueEnabled },
  );

  return { workers, queueEvents, monitorTargets, stop: gate.stop };
}

function buildWorkerTierMap(
  workers: Worker<LeagueSyncJobData>[],
  activeTiers: readonly MutationPriorityTier[],
): Record<MutationPriorityTier, Worker<LeagueSyncJobData>> {
  const fallback = workers[0];
  const workerByTier = {} as Record<MutationPriorityTier, Worker<LeagueSyncJobData>>;
  for (const tier of MUTATION_PRIORITY_ORDER) {
    const index = activeTiers.indexOf(tier);
    workerByTier[tier] = index >= 0 ? workers[index] : fallback;
  }
  return workerByTier;
}
