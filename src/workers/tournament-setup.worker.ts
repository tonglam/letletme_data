import { Job, QueueEvents, Worker } from 'bullmq';

import {
  getTournamentSetupQueueName,
  tournamentSetupQueue,
  tournamentSetupQueuesByTier,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import {
  recoverStuckTournamentSetups,
  setupTournamentStructure,
} from '../services/tournament-setup.service';
import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { getQueueConnection } from '../utils/queue';
import type { WorkerRuntime } from './worker-runtime';

const STUCK_PROCESSING_CUTOFF_MINUTES = Number(
  process.env.TOURNAMENT_SETUP_STUCK_CUTOFF_MINUTES ?? 15,
);
const WATCHDOG_INTERVAL_MS = Number(process.env.TOURNAMENT_SETUP_WATCHDOG_INTERVAL_MS ?? 300_000);

async function hasActiveSetupJob(tournamentId: number): Promise<boolean> {
  try {
    const activeJobs = await tournamentSetupQueue.getJobs(['active']);
    return activeJobs.some((job) => job.data.tournamentId === tournamentId);
  } catch (error) {
    logError('Failed to check active setup jobs', error, { tournamentId });
    // If we can't tell, be conservative and don't recover.
    return true;
  }
}

export function createTournamentSetupWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const queueName = getTournamentSetupQueueName('p0');
  const queueEvents = new QueueEvents(queueName, { connection });
  let watchdogInterval: ReturnType<typeof setInterval> | null = null;

  const worker = new Worker<TournamentSetupJobData>(
    queueName,
    async (job: Job<TournamentSetupJobData>) => {
      // Per-tournament lifecycle lock only (not tournament-structure:global):
      // serializes force-requeue / concurrency>1 for the same tournament so
      // markSetupProcessing/Result cannot interleave, without starving cascade
      // structure writers. Structure global is acquired only around rebuild /
      // points/knockout writes inside setup phases (FP-07 Codex P2).
      await withMutationConflictGuard(
        {
          queueName: job.queueName,
          jobName: job.name,
          jobId: String(job.id),
          tournamentId: job.data.tournamentId,
          scopes: [tournamentSetupLifecycleScope(job.data.tournamentId)],
        },
        () => setupTournamentStructure(job.data.tournamentId),
      );
    },
    {
      connection,
      concurrency: 2,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
    },
  );

  worker.on('completed', (job) => {
    logInfo('Tournament setup worker completed job', {
      jobId: job.id,
      tournamentId: job.data.tournamentId,
    });
  });

  worker.on('failed', (job, err) => {
    logError('Tournament setup worker failed job', err, {
      jobId: job?.id,
      tournamentId: job?.data.tournamentId,
    });
    if (job) {
      void alertOnFinalFailure(job, err);
    }
  });

  worker.on('error', (err) => {
    logError('Tournament setup worker error', err);
  });

  worker.on('ready', () => {
    void runStartupWatchdog();
    if (!watchdogInterval) {
      watchdogInterval = setInterval(() => {
        void runStartupWatchdog();
      }, WATCHDOG_INTERVAL_MS);
      watchdogInterval.unref?.();
    }
  });

  worker.on('closed', () => {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
  });

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [
      {
        queue: tournamentSetupQueuesByTier.p0,
        queueEvents,
        queueName,
        tier: 'p0',
      },
    ],
  };
}

async function runStartupWatchdog(): Promise<void> {
  try {
    const { recovered, skippedActive } = await recoverStuckTournamentSetups(
      STUCK_PROCESSING_CUTOFF_MINUTES,
      hasActiveSetupJob,
    );
    if (recovered.length > 0) {
      logInfo('Tournament setup watchdog recovered stuck setups', {
        count: recovered.length,
        tournamentIds: recovered,
      });
    }
    if (skippedActive.length > 0) {
      logInfo('Tournament setup watchdog skipped active setups', {
        count: skippedActive.length,
        tournamentIds: skippedActive,
      });
    }
  } catch (error) {
    logError('Tournament setup startup watchdog failed', error);
  }
}
