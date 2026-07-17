import { Job, QueueEvents, Worker } from 'bullmq';

import {
  getTournamentSetupQueueName,
  tournamentSetupQueuesByTier,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import {
  recoverStuckTournamentSetups,
  setupTournamentStructure,
} from '../services/tournament-setup.service';
import { logError, logInfo } from '../utils/logger';
import { getQueueConnection } from '../utils/queue';
import type { WorkerRuntime } from './worker-runtime';

const STUCK_PROCESSING_CUTOFF_MINUTES = Number(
  process.env.TOURNAMENT_SETUP_STUCK_CUTOFF_MINUTES ?? 15,
);
const WATCHDOG_INTERVAL_MS = Number(process.env.TOURNAMENT_SETUP_WATCHDOG_INTERVAL_MS ?? 300_000);

export function createTournamentSetupWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const queueName = getTournamentSetupQueueName('p0');
  const queueEvents = new QueueEvents(queueName, { connection });
  let watchdogInterval: ReturnType<typeof setInterval> | null = null;

  const worker = new Worker<TournamentSetupJobData>(
    queueName,
    async (job: Job<TournamentSetupJobData>) => {
      // Locks are acquired per phase inside setupTournamentStructure (entry-core
      // for FPL entry sync; structure global only around rebuild / per-event
      // backfill). Do not wrap the whole job — long FPL/backfill would starve
      // cascade structure writers on tournament-structure:global (FP-07 P1).
      await setupTournamentStructure(job.data.tournamentId);
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
    const { recovered } = await recoverStuckTournamentSetups(STUCK_PROCESSING_CUTOFF_MINUTES);
    if (recovered.length > 0) {
      logInfo('Tournament setup watchdog recovered stuck setups', {
        count: recovered.length,
        tournamentIds: recovered,
      });
    }
  } catch (error) {
    logError('Tournament setup startup watchdog failed', error);
  }
}
