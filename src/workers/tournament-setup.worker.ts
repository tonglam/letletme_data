import { Job, QueueEvents, Worker } from 'bullmq';

import {
  tournamentSetupQueue,
  tournamentSetupQueueName,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import { tournamentSyncQueue } from '../queues/tournament-sync.queue';
import {
  enqueueTournamentRosterReconcile,
  findTournamentRosterReconcileJob,
} from '../jobs/tournament-sync.jobs';
import { findTournamentSetupJob } from '../jobs/tournament-setup.jobs';
import {
  recoverStuckTournamentSetups,
  setupTournamentStructure,
} from '../services/tournament-setup.service';
import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import { seasonRepository } from '../repositories/seasons';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { logError, logInfo } from '../utils/logger';
import { runWithFplRequestMetrics } from '../utils/fpl-request-metrics';
import { runTrackedJob } from '../utils/job-run-logger';
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
    const [setupJobs, resumeJobs] = await Promise.all([
      tournamentSetupQueue.getJobs(['waiting', 'waiting-children', 'delayed', 'active', 'paused']),
      tournamentSyncQueue.getJobs(['waiting', 'waiting-children', 'delayed', 'active', 'paused']),
    ]);
    return (
      setupJobs.some((job) => job.data.tournamentId === tournamentId) ||
      resumeJobs.some(
        (job) =>
          job.name === 'tournament-roster-reconcile' && job.data.tournamentId === tournamentId,
      )
    );
  } catch (error) {
    logError('Failed to check active setup jobs', error, { tournamentId });
    // If we can't tell, be conservative and don't recover.
    return true;
  }
}

export function createTournamentSetupWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const queueEvents = new QueueEvents(tournamentSetupQueueName, { connection });
  let watchdogInterval: ReturnType<typeof setInterval> | null = null;

  const worker = new Worker<TournamentSetupJobData>(
    tournamentSetupQueueName,
    async (job: Job<TournamentSetupJobData>) => {
      const season = await requireCurrentSeasonForJob(job.data);
      await job.updateProgress('waiting_for_lifecycle');
      const triggeredAtMs = Date.parse(job.data.triggeredAt);
      const queueWaitMs = Number.isNaN(triggeredAtMs)
        ? null
        : Math.max(0, Date.now() - triggeredAtMs);
      const context = {
        jobType: 'queue' as const,
        jobName: job.name,
        queueName: job.queueName,
        jobId: job.id,
        tournamentId: job.data.tournamentId,
        source: job.data.source,
        attempt: job.attemptsMade + 1,
        queueWaitMs,
      };
      // Per-tournament lifecycle lock only (not tournament-structure:global):
      // serializes force-requeue / concurrency>1 for the same tournament so
      // markSetupProcessing/Result cannot interleave, without starving cascade
      // structure writers. Structure global is acquired only around rebuild /
      // points/knockout writes inside setup phases (FP-07 Codex P2).
      await runWithFplRequestMetrics(() =>
        runTrackedJob(context, () =>
          withMutationConflictGuard(
            {
              queueName: job.queueName,
              jobName: job.name,
              jobId: String(job.id),
              tournamentId: job.data.tournamentId,
              scopes: [tournamentSetupLifecycleScope(job.data.tournamentId)],
            },
            async () => {
              if (job.data.resumeMarker) {
                const ownsResume = await tournamentRosterRepository.markResumeProcessingIfPending(
                  season,
                  job.data.tournamentId,
                  job.data.resumeMarker,
                );
                if (!ownsResume) {
                  logInfo('Ignoring stale tournament resume setup job', {
                    tournamentId: job.data.tournamentId,
                    jobId: job.id,
                  });
                  return;
                }
              } else {
                // Official-sync activation owns the setup lifecycle through
                // the roster reconciliation marker. A pre-existing manual or
                // watchdog setup job has no marker and must not rebuild from
                // the old roster while that authoritative reconciliation is
                // pending, even if it was already active before activation.
                const roster = await tournamentRosterRepository.findById(
                  season,
                  job.data.tournamentId,
                );
                const resumePending =
                  roster?.rosterMode === 'official_sync' &&
                  roster.state === 'inactive' &&
                  (roster.rosterSyncStatus === 'processing' ||
                    roster.rosterSyncStatus === 'failed') &&
                  (roster.setupStatus === 'pending' ||
                    roster.setupStatus === 'processing' ||
                    roster.setupStatus === 'failed') &&
                  (roster.setupPhase === 'queued' ||
                    roster.setupPhase === 'failed' ||
                    roster.setupStatus === 'processing');

                if (resumePending) {
                  if (job.data.source === 'watchdog') {
                    // Watchdog recovery replays the marker-pinned roster
                    // operation first; it must never rebuild from an old
                    // roster while the authoritative publication is pending.
                    logInfo('Ignoring watchdog setup job before roster resume', {
                      tournamentId: job.data.tournamentId,
                      jobId: job.id,
                    });
                    return;
                  }

                  if (job.data.source !== 'manual') {
                    logInfo('Ignoring unmarked setup job during official roster resume', {
                      tournamentId: job.data.tournamentId,
                      jobId: job.id,
                      source: job.data.source,
                    });
                    return;
                  }

                  // An explicit manual retry is allowed to recover a
                  // terminal resume, but never while marker-owned work is
                  // still live.
                  const [reconcileJob, setupJob] = await Promise.all([
                    findTournamentRosterReconcileJob(
                      season,
                      job.data.tournamentId,
                      true,
                      roster?.setupProgressUpdatedAt ?? undefined,
                    ),
                    findTournamentSetupJob(
                      season,
                      job.data.tournamentId,
                      roster?.setupProgressUpdatedAt,
                    ),
                  ]);
                  if (reconcileJob || setupJob) {
                    logInfo('Ignoring manual setup retry during official roster resume', {
                      tournamentId: job.data.tournamentId,
                      jobId: job.id,
                    });
                    return;
                  }
                }
              }
              await job.updateProgress('running');
              try {
                logInfo('Tournament setup worker started job');
                await setupTournamentStructure(season, job.data.tournamentId, {
                  resumeMarker: job.data.resumeMarker,
                });
              } finally {
                // Written before the mandatory lifecycle lock is released, so
                // an enqueuer that later acquires it can safely alternate slots.
                await job.updateProgress('settling');
              }
            },
          ),
        ),
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
        queue: tournamentSetupQueue,
        queueEvents,
        queueName: tournamentSetupQueueName,
      },
    ],
  };
}

async function runStartupWatchdog(): Promise<void> {
  try {
    const season = await seasonRepository.findCurrent();
    const { recovered, skippedActive } = await recoverStuckTournamentSetups(
      season,
      STUCK_PROCESSING_CUTOFF_MINUTES,
      hasActiveSetupJob,
      async (currentSeason, tournamentId, resumeMarker) => {
        await enqueueTournamentRosterReconcile(currentSeason, tournamentId, 'watchdog', {
          resumeAfterSetup: true,
          resumeMarker,
          allowInactive: true,
        });
      },
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
