import { Job, QueueEvents, Worker } from 'bullmq';

import { enqueueTournamentRepair } from '../jobs/tournament-repair.jobs';
import {
  tournamentRepairQueue,
  type TournamentRepairJobData,
} from '../queues/tournament-repair.queue';
import { tournamentRepairQueueName } from '../queues/names';
import { seasonRepository } from '../repositories/seasons';
import { tournamentSetupIssueRepository } from '../repositories/tournament-setup-issues';
import { repairTournamentSetupIssue } from '../services/tournament-repair.service';
import { reconcileReadyTournamentWarnings } from '../services/tournament-setup-reconciliation.service';
import { getQueueConnection } from '../utils/queue';
import { isTerminalJobFailure } from '../utils/worker-failure';
import { logError, logInfo } from '../utils/logger';
import type { WorkerRuntime } from './worker-runtime';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';

const REPAIR_WATCHDOG_INTERVAL_MS = 6 * 60 * 60_000;
const REPAIR_BACKOFF_MS = 5 * 60_000;

async function enqueueDueRepairs(): Promise<void> {
  const issues = await tournamentSetupIssueRepository.findRepairableDue();
  for (const issue of issues) {
    const season = await seasonRepository.findById(issue.seasonId);
    if (!season) continue;
    await enqueueTournamentRepair(season, issue, 'watchdog');
  }
  if (issues.length > 0) {
    logInfo('Tournament repair watchdog enqueued due issues', { count: issues.length });
  }
}

export function createTournamentRepairWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const queueEvents = new QueueEvents(tournamentRepairQueueName, { connection });
  let watchdog: ReturnType<typeof setInterval> | null = null;
  const worker = new Worker<TournamentRepairJobData>(
    tournamentRepairQueueName,
    async (job: Job<TournamentRepairJobData>) => {
      const season = await seasonRepository.findByCode(job.data.seasonCode);
      if (!season) return;
      await repairTournamentSetupIssue(season, job.data.issueId);
    },
    {
      connection,
      concurrency: 4,
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
      removeOnComplete: BULL_COMPLETED_RETENTION,
      removeOnFail: BULL_FAILED_RETENTION,
    },
  );

  worker.on('failed', (job, error) => {
    if (!job) return;
    void (async () => {
      const issue = await tournamentSetupIssueRepository.findUnresolvedById(
        { seasonId: job.data.seasonId, seasonCode: job.data.seasonCode },
        job.data.issueId,
      );
      if (!issue) return;
      const exhausted = isTerminalJobFailure(job, error);
      const nextRepairAt = exhausted
        ? new Date(Date.now() + 24 * 60 * 60_000)
        : new Date(Date.now() + REPAIR_BACKOFF_MS * 2 ** Math.max(0, job.attemptsMade - 1));
      await tournamentSetupIssueRepository.recordRepairAttempt(
        issue.issueId,
        nextRepairAt,
        exhausted,
      );
    })().catch((stateError) => {
      logError('Failed to persist tournament repair retry state', stateError, {
        issueId: job.data.issueId,
        tournamentId: job.data.tournamentId,
      });
    });
  });

  worker.on('error', (error) => logError('Tournament repair worker error', error));
  worker.on('ready', () => {
    void (async () => {
      const season = await seasonRepository.findCurrent();
      await reconcileReadyTournamentWarnings(season);
    })().catch((error) => logError('Tournament warning reconciliation failed', error));
    void enqueueDueRepairs();
    if (!watchdog) {
      watchdog = setInterval(() => void enqueueDueRepairs(), REPAIR_WATCHDOG_INTERVAL_MS);
      watchdog.unref?.();
    }
  });
  worker.on('closed', () => {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
  });

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [
      { queue: tournamentRepairQueue, queueEvents, queueName: tournamentRepairQueueName },
    ],
  };
}
