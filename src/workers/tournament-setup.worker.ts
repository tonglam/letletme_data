import { Job, QueueEvents, Worker } from 'bullmq';

import {
  tournamentSetupQueue,
  tournamentSetupQueueName,
  getTournamentSetupRetryDelayMs,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import { tournamentSyncQueue } from '../queues/tournament-sync.queue';
import { enqueueTournamentRosterReconcile } from '../jobs/tournament-sync.jobs';
import { enqueueTournamentSetup } from '../jobs/tournament-setup.jobs';
import {
  recoverStuckTournamentSetups,
  setupTournamentStructure,
} from '../services/tournament-setup.service';
import {
  persistEscapedTournamentSetupFailure,
  tournamentSetupErrorCode,
} from '../services/tournament-setup-failure.service';
import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import { requireCurrentSeasonForJob } from '../services/season-scoped-job.service';
import { seasonRepository } from '../repositories/seasons';
import {
  tournamentInfoRepository,
  type TournamentSetupExecution,
  type TournamentSetupFailureState,
} from '../repositories/tournament-infos';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { logError, logInfo } from '../utils/logger';
import { runWithFplRequestMetrics } from '../utils/fpl-request-metrics';
import { runTrackedJob } from '../utils/job-run-logger';
import { alertOnFinalFailure } from '../utils/notify';
import { withMutationScopes } from '../utils/mutation-scopes';
import { getQueueConnection } from '../utils/queue';
import { isTerminalJobAttemptFailure } from '../utils/worker-failure';
import type { WorkerRuntime } from './worker-runtime';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import { getConfig } from '../utils/config';

const runtimeConfig = getConfig();
const STUCK_PROCESSING_CUTOFF_MINUTES = runtimeConfig.TOURNAMENT_SETUP_STUCK_CUTOFF_MINUTES;
const WATCHDOG_INTERVAL_MS = runtimeConfig.TOURNAMENT_SETUP_WATCHDOG_INTERVAL_MS;

type SetupFailure = { error: unknown };
const setupFailuresPersistedInProcessor = new Set<string>();
const setupExecutions = new Map<string, TournamentSetupExecution>();
const RECLAIMABLE_SETUP_PHASES = new Set([
  'queued',
  'syncing_entries',
  'building_structure',
  'calculating_standings',
  'enriching_history',
  'finalizing',
]);

function isReclaimableSetupPhase(phase: string | null | undefined): boolean {
  return phase !== undefined && phase !== null && RECLAIMABLE_SETUP_PHASES.has(phase);
}

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

export async function processTournamentSetupJob(job: Job<TournamentSetupJobData>): Promise<void> {
  const setupFailureKey = setupJobKey(job);
  setupFailuresPersistedInProcessor.delete(setupFailureKey);
  setupExecutions.delete(setupFailureKey);
  const season = await requireCurrentSeasonForJob(job.data);
  await updateSetupJobProgressBestEffort(job, 'waiting_for_lifecycle');
  const triggeredAtMs = Date.parse(job.data.triggeredAt);
  const queueWaitMs = Number.isNaN(triggeredAtMs) ? null : Math.max(0, Date.now() - triggeredAtMs);
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
  const failure = await runWithFplRequestMetrics(() =>
    runTrackedJob(context, async (): Promise<SetupFailure | null> => {
      const bullmqAttempt = Math.max(1, job.attemptsMade + 1);
      let attempt = bullmqAttempt;
      let maxAttempts = Math.max(1, job.opts.attempts ?? 1);
      const startedAt = new Date();
      let execution: TournamentSetupExecution | undefined;
      let expectedState: TournamentSetupFailureState | undefined;
      const lifecycle = <T>(operation: () => Promise<T>) =>
        withMutationScopes(
          {
            queueName: job.queueName,
            jobName: job.name,
            jobId: String(job.id),
            tournamentId: job.data.tournamentId,
            scopes: [tournamentSetupLifecycleScope(job.data.tournamentId)],
          },
          operation,
        );
      try {
        const claim = await lifecycle(async () => {
          expectedState =
            (await tournamentInfoRepository.findSetupStatus(season, job.data.tournamentId)) ??
            undefined;
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
          } else if (job.data.preparedRetryMarker) {
            const preparedStatus = await tournamentInfoRepository.findSetupStatus(
              season,
              job.data.tournamentId,
            );
            const preparedRoster = await tournamentRosterRepository.findById(
              season,
              job.data.tournamentId,
            );
            if (
              preparedStatus?.setupStatus !== 'processing' ||
              !isReclaimableSetupPhase(preparedStatus.setupPhase) ||
              preparedStatus.setupProgressUpdatedAt !== job.data.preparedRetryMarker ||
              (preparedRoster?.rosterMode === 'official_sync' &&
                preparedRoster.rosterSyncStatus === 'pending')
            ) {
              logInfo('Ignoring stale prepared tournament setup retry', {
                tournamentId: job.data.tournamentId,
                jobId: job.id,
              });
              return null;
            }
          } else if (job.data.setupMarker) {
            const markedStatus = await tournamentInfoRepository.findSetupStatus(
              season,
              job.data.tournamentId,
            );
            const markedRoster = await tournamentRosterRepository.findById(
              season,
              job.data.tournamentId,
            );
            if (
              !['pending', 'processing'].includes(markedStatus?.setupStatus ?? '') ||
              !isReclaimableSetupPhase(markedStatus?.setupPhase) ||
              markedStatus?.setupProgressUpdatedAt !== job.data.setupMarker ||
              (markedRoster?.rosterMode === 'official_sync' &&
                markedRoster.rosterSyncStatus === 'pending')
            ) {
              logInfo('Ignoring stale roster publication setup job', {
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
            const roster = await tournamentRosterRepository.findById(season, job.data.tournamentId);
            if (roster?.rosterMode === 'official_sync' && roster.rosterSyncStatus === 'pending') {
              logInfo('Ignoring unmarked setup before roster retry handoff', {
                tournamentId: job.data.tournamentId,
                jobId: job.id,
              });
              return null;
            }
            const resumePending =
              roster?.rosterMode === 'official_sync' &&
              roster.state === 'inactive' &&
              (roster.rosterSyncStatus === 'processing' || roster.rosterSyncStatus === 'failed') &&
              (roster.setupStatus === 'pending' ||
                roster.setupStatus === 'processing' ||
                roster.setupStatus === 'failed') &&
              (roster.setupPhase === 'queued' ||
                roster.setupPhase === 'failed' ||
                roster.setupStatus === 'processing');

            if (resumePending) {
              // Only marker-owned setup jobs may run while an official roster
              // resume is pending. The marker is copied into every prepared
              // handoff, so an unmarked job cannot race queue admission after
              // a negative Redis probe.
              logInfo('Ignoring unmarked setup during committed official resume', {
                tournamentId: job.data.tournamentId,
                jobId: job.id,
                source: job.data.source,
              });
              return null;
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

          const stableProgressMarker =
            job.data.resumeMarker ?? job.data.preparedRetryMarker ?? job.data.setupMarker;
          return tournamentInfoRepository.markSetupProcessing(
            season,
            job.data.tournamentId,
            stableProgressMarker,
            attempt,
          );
        });
        if (!claim) return null;
        execution = claim;
        setupExecutions.set(setupFailureKey, claim);
        await updateSetupJobProgressBestEffort(job, 'running');
        logInfo('Tournament setup worker started job');
        await setupTournamentStructure(season, job.data.tournamentId, {
          resumeMarker: job.data.resumeMarker,
          progressMarker:
            job.data.resumeMarker ?? job.data.preparedRetryMarker ?? job.data.setupMarker,
          execution,
        });
        return null;
      } catch (error) {
        if (tournamentSetupErrorCode(error) === 'TOURNAMENT_SETUP_EXECUTION_STALE') {
          logInfo('Settling superseded tournament setup delivery', {
            tournamentId: job.data.tournamentId,
            jobId: job.id,
          });
          return null;
        }
        const terminal = isTerminalJobAttemptFailure(job, error, attempt) || attempt >= maxAttempts;
        const changed = await lifecycle(async () => {
          const changed = await tournamentInfoRepository.markSetupAttemptFailure(
            season,
            job.data.tournamentId,
            {
              execution,
              expectedState,
              attempt,
              terminal,
              errorCode: tournamentSetupErrorCode(error),
              nextRetryAt: terminal
                ? null
                : new Date(Date.now() + getTournamentSetupRetryDelayMs(attempt)),
              startedAt,
              progressMarker:
                job.data.resumeMarker ?? job.data.preparedRetryMarker ?? job.data.setupMarker,
            },
          );
          if (!changed)
            logInfo('Ignoring stale tournament setup failure state', {
              tournamentId: job.data.tournamentId,
              jobId: job.id,
              attempt,
            });
          return changed;
        });
        if (!changed && (execution || expectedState)) return null;
        return { error };
      } finally {
        await updateSetupJobProgressBestEffort(job, 'settling');
      }
    }),
  );
  if (failure) {
    // Reaching this point proves the failure lifecycle transaction committed
    // the retry state. The failed listener must not persist it a second time.
    setupFailuresPersistedInProcessor.add(setupFailureKey);
    throw failure.error;
  }
}

export function createTournamentSetupWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const queueEvents = new QueueEvents(tournamentSetupQueueName, { connection });
  let watchdogInterval: ReturnType<typeof setInterval> | null = null;

  const worker = new Worker<TournamentSetupJobData>(
    tournamentSetupQueueName,
    processTournamentSetupJob,
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
    setupExecutions.delete(setupJobKey(job));
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
      const execution = setupExecutions.get(setupJobKey(job));
      setupExecutions.delete(setupJobKey(job));
      const alreadyPersisted = setupFailuresPersistedInProcessor.delete(setupJobKey(job));
      if (!alreadyPersisted) {
        void persistEscapedTournamentSetupFailure(job, err, undefined, execution)
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
