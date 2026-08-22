import { Job, QueueEvents, Worker } from 'bullmq';

import {
  tournamentSetupQueue,
  tournamentSetupQueueName,
  getTournamentSetupRetryDelayMs,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import { tournamentSyncQueue } from '../queues/tournament-sync.queue';
import {
  enqueueTournamentRosterReconcile,
  findTournamentRosterReconcileJob,
} from '../jobs/tournament-sync.jobs';
import { enqueueTournamentSetup, findTournamentSetupJob } from '../jobs/tournament-setup.jobs';
import {
  recoverStuckTournamentSetups,
  setupTournamentStructure,
} from '../services/tournament-setup.service';
import {
  persistEscapedTournamentSetupFailure,
  tournamentSetupErrorCode,
} from '../services/tournament-setup-failure.service';
import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import { seasonRepository } from '../repositories/seasons';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { withDatabaseSavepoint } from '../db/singleton';
import { logError, logInfo } from '../utils/logger';
import { runWithFplRequestMetrics } from '../utils/fpl-request-metrics';
import { runTrackedJob } from '../utils/job-run-logger';
import { alertOnFinalFailure } from '../utils/notify';
import { withMutationScopes } from '../utils/mutation-scopes';
import { getQueueConnection } from '../utils/queue';
import { isTerminalJobAttemptFailure } from '../utils/worker-failure';
import type { WorkerRuntime } from './worker-runtime';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';

const STUCK_PROCESSING_CUTOFF_MINUTES = Number(
  process.env.TOURNAMENT_SETUP_STUCK_CUTOFF_MINUTES ?? 15,
);
const WATCHDOG_INTERVAL_MS = Number(process.env.TOURNAMENT_SETUP_WATCHDOG_INTERVAL_MS ?? 300_000);

type SetupFailure = { error: unknown };
const setupFailuresPersistedInProcessor = new Set<string>();

function setupJobKey(job: Pick<Job<TournamentSetupJobData>, 'id'>): string {
  return String(job.id);
}

async function updateSetupJobProgressBestEffort(
  job: Job<TournamentSetupJobData>,
  progress: string,
): Promise<void> {
  try {
    await job.updateProgress(progress);
  } catch (error) {
    logError('Unable to update tournament setup job progress', error, {
      tournamentId: job.data.tournamentId,
      jobId: job.id,
      progress,
    });
  }
}

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
      const setupFailureKey = setupJobKey(job);
      setupFailuresPersistedInProcessor.delete(setupFailureKey);
      const season = await requireCurrentSeasonForJob(job.data);
      await updateSetupJobProgressBestEffort(job, 'waiting_for_lifecycle');
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
      const failure = await runWithFplRequestMetrics(() =>
        runTrackedJob(context, () =>
          withMutationScopes(
            {
              queueName: job.queueName,
              jobName: job.name,
              jobId: String(job.id),
              tournamentId: job.data.tournamentId,
              scopes: [tournamentSetupLifecycleScope(job.data.tournamentId)],
            },
            async (): Promise<SetupFailure | null> => {
              const bullmqAttempt = Math.max(1, job.attemptsMade + 1);
              let attempt = bullmqAttempt;
              let maxAttempts = Math.max(1, job.opts.attempts ?? 1);
              const startedAt = new Date();
              let attemptFailure: SetupFailure | null = null;

              try {
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
                    return null;
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
                      return null;
                    }

                    if (job.data.source !== 'manual') {
                      logInfo('Ignoring unmarked setup job during official roster resume', {
                        tournamentId: job.data.tournamentId,
                        jobId: job.id,
                        source: job.data.source,
                      });
                      return null;
                    }

                    // An explicit manual retry is allowed to recover a
                    // terminal resume, but never while marker-owned work
                    // is still live.
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
                      return null;
                    }
                  }
                }

                const persistedStatus = await tournamentInfoRepository.findSetupStatus(
                  season,
                  job.data.tournamentId,
                );
                if (!persistedStatus) {
                  logInfo('Ignoring tournament setup job for a deleted tournament', {
                    tournamentId: job.data.tournamentId,
                    jobId: job.id,
                  });
                  return null;
                }
                if (
                  persistedStatus.setupStatus === 'ready' ||
                  (persistedStatus.setupStatus === 'failed' && !persistedStatus.setupNextRetryAt)
                ) {
                  logInfo('Ignoring stale tournament setup job after terminal state', {
                    tournamentId: job.data.tournamentId,
                    jobId: job.id,
                    setupStatus: persistedStatus.setupStatus,
                  });
                  return null;
                }

                maxAttempts = Math.max(1, persistedStatus.setupMaxAttempts ?? maxAttempts);
                const nextAttempt = Math.max(
                  bullmqAttempt,
                  Math.max(0, persistedStatus.setupAttempt ?? 0) + 1,
                );
                attempt = Math.min(maxAttempts, nextAttempt);
                context.attempt = attempt;
                if (nextAttempt > maxAttempts) {
                  throw Object.assign(new Error('Tournament setup automatic retries exhausted.'), {
                    code: persistedStatus.setupLastErrorCode ?? 'SETUP_AUTOMATIC_RETRIES_EXHAUSTED',
                  });
                }

                await updateSetupJobProgressBestEffort(job, 'running');
                logInfo('Tournament setup worker started job');
                await withDatabaseSavepoint(() =>
                  setupTournamentStructure(season, job.data.tournamentId, {
                    resumeMarker: job.data.resumeMarker,
                    attempt,
                  }),
                );
              } catch (error) {
                const terminal =
                  isTerminalJobAttemptFailure(job, error, attempt) || attempt >= maxAttempts;
                const changed = await tournamentInfoRepository.markSetupAttemptFailure(
                  season,
                  job.data.tournamentId,
                  {
                    attempt,
                    terminal,
                    errorCode: tournamentSetupErrorCode(error),
                    nextRetryAt: terminal
                      ? null
                      : new Date(Date.now() + getTournamentSetupRetryDelayMs(attempt)),
                    startedAt,
                  },
                );
                if (!changed) {
                  logInfo('Ignoring stale tournament setup failure state', {
                    tournamentId: job.data.tournamentId,
                    jobId: job.id,
                    attempt,
                  });
                }
                attemptFailure = { error };
              } finally {
                // Written before the mandatory lifecycle lock is released, so
                // an enqueuer that later acquires it can safely alternate slots.
                await updateSetupJobProgressBestEffort(job, 'settling');
              }

              return attemptFailure;
            },
          ),
        ),
      );
      if (failure) {
        // Reaching this point proves the outer lifecycle transaction committed
        // the retry state. The failed listener must not persist it a second time.
        setupFailuresPersistedInProcessor.add(setupFailureKey);
        throw failure.error;
      }
    },
    {
      connection,
      concurrency: 2,
      removeOnComplete: BULL_COMPLETED_RETENTION,
      removeOnFail: BULL_FAILED_RETENTION,
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
      const alreadyPersisted = setupFailuresPersistedInProcessor.delete(setupJobKey(job));
      if (!alreadyPersisted) {
        void persistEscapedTournamentSetupFailure(job, err)
          .then((changed) => {
            logInfo('Tournament setup escaped failure fallback completed', {
              jobId: job.id,
              tournamentId: job.data.tournamentId,
              changed,
            });
          })
          .catch((error) => {
            logError('Tournament setup escaped failure fallback failed', error, {
              jobId: job.id,
              tournamentId: job.data.tournamentId,
            });
          });
      }
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
      async (
        currentSeason,
        tournamentId,
        resumeMarker,
        setupStatus,
        setupPhase,
        rosterLastSyncedAt,
      ) => {
        const progressMs = Date.parse(resumeMarker);
        const rosterSyncedMs = rosterLastSyncedAt ? Date.parse(rosterLastSyncedAt) : Number.NaN;
        const rosterWasPublished =
          Number.isFinite(progressMs) &&
          Number.isFinite(rosterSyncedMs) &&
          rosterSyncedMs >= progressMs;
        if (setupStatus === 'processing' || rosterWasPublished) {
          await enqueueTournamentSetup(currentSeason, tournamentId, 'resume', {
            forceNew: true,
            ensureSuccessorOnActive: true,
            activeSettleTimeoutMs: 2_000,
            resumeMarker,
          });
          return;
        }
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
