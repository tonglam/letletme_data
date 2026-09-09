import { QueueEvents, UnrecoverableError, Worker, type Job } from 'bullmq';

import { UnderstatClientError } from '../clients/understat';

import {
  getUnderstatPlayerQueue,
  type UnderstatPlayerJobData,
  understatPlayerQueueName,
} from '../queues/understat-player.queue';
import {
  getUnderstatTeamQueue,
  type UnderstatTeamJobData,
  understatTeamQueueName,
} from '../queues/understat-team.queue';
import { renewSchedulerObligation } from '../repositories/scheduler-obligations';
import { completeSchedulerObligation } from '../services/scheduler-obligation-lifecycle.service';
import {
  discoverUnderstatPlayers,
  finalizeUnderstatPlayerRun,
  syncUnderstatPlayerMatch,
  syncUnderstatPlayerTeamDetail,
  understatPlayerItemForJob,
} from '../services/understat-player.service';
import {
  discoverUnderstatTeams,
  finalizeUnderstatTeamRun,
  syncUnderstatTeamDetail,
  understatTeamItemForJob,
} from '../services/understat-team.service';
import {
  IncompleteUnderstatResourceError,
  SupersededUnderstatDiscoveryError,
  understatMutationScopes,
} from '../services/understat-sync.service';
import { understatSyncRepository } from '../repositories/understat-sync';
import { getConfig } from '../utils/config';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { logError, logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';
import { alertOnFinalFailure } from '../utils/notify';
import { getQueueConnection } from '../utils/queue';
import { isTerminalJobAttemptFailure, isTerminalJobFailure } from '../utils/worker-failure';
import {
  isUnderstatNonRetryableError,
  settleUnderstatCompleteness,
  settleUnderstatObligationFailure,
} from '../services/understat-recovery.service';
import type { WorkerRuntime } from './worker-runtime';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';
import { understatFailureBookkeepingPlan } from '../utils/understat-failure-bookkeeping';

function lockScopes(
  lane: 'team' | 'player',
  name: string,
  data: UnderstatTeamJobData | UnderstatPlayerJobData,
): string[] {
  const resourceId =
    lane === 'team'
      ? (data as UnderstatTeamJobData).teamId
      : (data as UnderstatPlayerJobData).resourceId;
  return understatMutationScopes(lane, name, data.season, resourceId);
}

async function runUnderstatOperation(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof UnderstatClientError && !error.retryable) {
      throw new UnrecoverableError(`${error.code}: ${error.message}`);
    }
    throw error;
  }
}

function understatBackoff(attemptsMade: number, type?: string, error?: Error): number {
  if (type !== 'understat') return 0;
  if (error instanceof UnderstatClientError && error.retryAfterMs !== null) {
    return error.retryAfterMs;
  }
  const ceiling = Math.min(1_000 * 2 ** Math.max(attemptsMade - 1, 0), 60_000);
  return Math.floor(Math.random() * (ceiling + 1));
}

function startSchedulerLeaseHeartbeat(
  job: Job<UnderstatTeamJobData | UnderstatPlayerJobData>,
): () => void {
  const fence = inspectSchedulerObligationFence(job.data);
  if (fence.kind !== 'complete') return () => undefined;
  const renew = () =>
    renewSchedulerObligation({
      obligationId: fence.obligationId,
      generation: fence.generation,
    }).catch((error) => {
      logError('Failed to renew Understat scheduler obligation lease', error, {
        runId: job.data.runId,
        jobId: job.id,
        generation: fence.generation,
      });
    });
  // Most chained jobs complete in under a minute. Renew at the boundary as
  // well as on the interval so a long fan-out cannot expire between jobs.
  void renew();
  const timer = setInterval(() => void renew(), 60_000);
  return () => clearInterval(timer);
}

const claimedAttempts = new WeakMap<object, number>();

async function processTeamJob(job: Job<UnderstatTeamJobData>): Promise<void> {
  if (
    !(await startCurrentSchedulerJob(job.data, {
      queueName: job.queueName,
      jobName: job.name,
      jobId: job.id,
    }))
  ) {
    return;
  }
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data.trigger,
    attempt: job.attemptsMade + 1,
  };
  logJobTriggered(context);
  const stopLeaseHeartbeat = startSchedulerLeaseHeartbeat(job);
  try {
    await runTrackedJob(context, () =>
      runUnderstatOperation(async () => {
        switch (job.name) {
          case 'understat-team-discover':
            return discoverUnderstatTeams(job.data, (attempt) => claimedAttempts.set(job, attempt));
          case 'understat-team-detail':
            return syncUnderstatTeamDetail(job.data, (attempt) =>
              claimedAttempts.set(job, attempt),
            );
          case 'understat-team-finalize':
            return finalizeUnderstatTeamRun(job.data);
          default:
            throw new Error(`Unknown Understat team job: ${job.name}`);
        }
      }),
    );
    await settleFinalizerOutcome(job);
    await settleDeferredUnderstatRunFailure(job);
  } catch (error) {
    try {
      await recordTerminalFailure(job, error);
    } finally {
      stopLeaseHeartbeat();
    }
    throw error;
  }
  stopLeaseHeartbeat();
}

async function processPlayerJob(job: Job<UnderstatPlayerJobData>): Promise<void> {
  if (
    !(await startCurrentSchedulerJob(job.data, {
      queueName: job.queueName,
      jobName: job.name,
      jobId: job.id,
    }))
  ) {
    return;
  }
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data.trigger,
    attempt: job.attemptsMade + 1,
  };
  logJobTriggered(context);
  const stopLeaseHeartbeat = startSchedulerLeaseHeartbeat(job);
  try {
    await runTrackedJob(context, () =>
      runUnderstatOperation(async () => {
        switch (job.name) {
          case 'understat-player-discover':
            return discoverUnderstatPlayers(job.data, (attempt) =>
              claimedAttempts.set(job, attempt),
            );
          case 'understat-player-team-detail':
            return syncUnderstatPlayerTeamDetail(job.data, (attempt) =>
              claimedAttempts.set(job, attempt),
            );
          case 'understat-player-match':
            return syncUnderstatPlayerMatch(job.data, (attempt) =>
              claimedAttempts.set(job, attempt),
            );
          case 'understat-player-finalize':
            return finalizeUnderstatPlayerRun(job.data);
          default:
            throw new Error(`Unknown Understat player job: ${job.name}`);
        }
      }),
    );
    await settleFinalizerOutcome(job);
    await settleDeferredUnderstatRunFailure(job);
  } catch (error) {
    try {
      await recordTerminalFailure(job, error);
    } finally {
      stopLeaseHeartbeat();
    }
    throw error;
  }
  stopLeaseHeartbeat();
}

async function settleFinalizerOutcome(
  job: Job<UnderstatTeamJobData | UnderstatPlayerJobData>,
): Promise<void> {
  if (!job.name.endsWith('-finalize') || !job.data.obligationId) return;
  const run = await understatSyncRepository.findRun(job.data.runId);
  if (!run)
    throw new Error(`Understat run ${job.data.runId} disappeared before finalization settlement`);
  if (run.status === 'completed') {
    await completeSchedulerObligation({
      obligationId: job.data.obligationId,
      generation: job.data.obligationGeneration,
      status: 'succeeded',
      evidence: {
        provider: 'understat',
        lane: run.lane,
        runId: run.runId,
        completionStage: 'finalizer',
      },
    });
    return;
  }
  if (run.status === 'skipped' && run.metadata.completeness === 'skipped') {
    await settleUnderstatCompleteness({
      obligationId: job.data.obligationId,
      generation: job.data.obligationGeneration,
      reason:
        run.errorSummary ??
        (typeof run.metadata.reason === 'string' ? run.metadata.reason : 'snapshot incomplete'),
    });
  }
}

function understatCompletenessReason(error: unknown): string | null {
  if (error instanceof IncompleteUnderstatResourceError) return error.message;
  if (error instanceof Error && error.name === 'IncompleteUnderstatResourceError') {
    return error.message;
  }
  if (typeof error === 'string' && error.includes(' incomplete: ')) return error;
  return null;
}

const ACTIVE_UNDERSTAT_RUN_STATUSES = new Set(['pending', 'running', 'ready_to_publish']);
const UNDERSTAT_DRAIN_LEASE_EXTENSION_MS = 30 * 60_000;

/**
 * A terminal detail failure is durable immediately, but the scheduler retry
 * must wait until every sibling item has drained. Otherwise the next
 * generation races the still-active predecessor and its discovery job is
 * rejected by findActiveRun().
 */
async function settleUnderstatFailureAfterRunDrained(
  job: Job<UnderstatTeamJobData | UnderstatPlayerJobData>,
  error: unknown,
  forceForTerminalRun = false,
): Promise<void> {
  const run = await understatSyncRepository.findRun(job.data.runId);
  const nonRetryable = isUnderstatNonRetryableError(error);
  if (run && ACTIVE_UNDERSTAT_RUN_STATUSES.has(run.status) && !nonRetryable) {
    if (job.data.obligationId) {
      await renewSchedulerObligation({
        obligationId: job.data.obligationId,
        generation: job.data.obligationGeneration,
        additionalLeaseMs: UNDERSTAT_DRAIN_LEASE_EXTENSION_MS,
      }).catch((renewError) =>
        logError('Failed to extend Understat drain lease', renewError, {
          runId: run.runId,
          jobId: job.id,
          generation: job.data.obligationGeneration,
        }),
      );
    }
    logInfo('Deferring Understat obligation retry until run drains', {
      runId: run.runId,
      jobId: job.id,
      status: run.status,
      generation: job.data.obligationGeneration,
    });
    return;
  }
  if (!forceForTerminalRun && run && run.status !== 'failed') return;
  const settledError =
    error instanceof Error
      ? error
      : new Error(run?.errorSummary ?? 'Understat run failed after worker drain');
  const completenessReason = understatCompletenessReason(settledError);
  if (completenessReason) {
    await settleUnderstatCompleteness({
      obligationId: job.data.obligationId,
      generation: job.data.obligationGeneration,
      reason: completenessReason,
    });
    return;
  }
  await settleUnderstatObligationFailure({
    obligationId: job.data.obligationId,
    generation: job.data.obligationGeneration,
    error: settledError,
    nonRetryable,
  });
}

async function settleDeferredUnderstatRunFailure(
  job: Job<UnderstatTeamJobData | UnderstatPlayerJobData>,
): Promise<void> {
  const run = await understatSyncRepository.findRun(job.data.runId);
  if (!run || run.status !== 'failed') return;
  const error = run.errorSummary ?? 'Understat run failed after worker drain';
  const completenessReason = understatCompletenessReason(error);
  if (completenessReason) {
    await settleUnderstatCompleteness({
      obligationId: job.data.obligationId,
      generation: job.data.obligationGeneration,
      reason: completenessReason,
    });
    return;
  }
  await settleUnderstatObligationFailure({
    obligationId: job.data.obligationId,
    generation: job.data.obligationGeneration,
    error: new Error(error),
    nonRetryable: false,
  });
}

async function recordTeamFailure(
  job: Job<UnderstatTeamJobData>,
  error: Error,
  terminal = isTerminalJobFailure(job, error),
): Promise<boolean> {
  if (!terminal) return false;
  return withMutationScopes(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
      scopes: lockScopes('team', job.name, job.data),
    },
    async () => {
      const item = understatTeamItemForJob(job.data, job.name);
      if (item) {
        const persisted = await understatSyncRepository.findItem(
          job.data.runId,
          item.resourceType,
          item.resourceId,
        );
        const expectedAttempt = claimedAttempts.get(job);
        if (persisted?.status === 'completed' || persisted?.status === 'skipped') {
          // A settled replay has no new claim, but can still exhaust its queue handoff.
          // A superseded provider invocation must not fail its successor's run.
          if (expectedAttempt !== undefined && persisted.attempts !== expectedAttempt) return false;
          await understatSyncRepository.markRunFailedIfSettled(job.data.runId, error.message);
          return true;
        }
        // An event without this invocation's claim cannot fail an in-flight retry.
        if (
          persisted &&
          (expectedAttempt === undefined
            ? persisted.attempts > 0
            : persisted.attempts !== expectedAttempt)
        )
          return false;
        await understatSyncRepository.failItem(
          job.data.runId,
          item.resourceType,
          item.resourceId,
          error.message,
        );
        return true;
      }
      await understatSyncRepository.markRunFailedIfSettled(job.data.runId, error.message);
      return true;
    },
  );
}

async function recordPlayerFailure(
  job: Job<UnderstatPlayerJobData>,
  error: Error,
  terminal = isTerminalJobFailure(job, error),
): Promise<boolean> {
  if (!terminal) return false;
  return withMutationScopes(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
      scopes: lockScopes('player', job.name, job.data),
    },
    async () => {
      const item = understatPlayerItemForJob(job.data, job.name);
      if (item) {
        const persisted = await understatSyncRepository.findItem(
          job.data.runId,
          item.resourceType,
          item.resourceId,
        );
        const expectedAttempt = claimedAttempts.get(job);
        if (persisted?.status === 'completed' || persisted?.status === 'skipped') {
          // A settled replay has no new claim, but can still exhaust its queue handoff.
          // A superseded provider invocation must not fail its successor's run.
          if (expectedAttempt !== undefined && persisted.attempts !== expectedAttempt) return false;
          await understatSyncRepository.markRunFailedIfSettled(job.data.runId, error.message);
          return true;
        }
        // An event without this invocation's claim cannot fail an in-flight retry.
        if (
          persisted &&
          (expectedAttempt === undefined
            ? persisted.attempts > 0
            : persisted.attempts !== expectedAttempt)
        )
          return false;
        await understatSyncRepository.failItem(
          job.data.runId,
          item.resourceType,
          item.resourceId,
          error.message,
        );
        return true;
      }
      await understatSyncRepository.markRunFailedIfSettled(job.data.runId, error.message);
      return true;
    },
  );
}

async function retireSupersededDiscoveryRun(
  job: Job<UnderstatTeamJobData | UnderstatPlayerJobData>,
  error: SupersededUnderstatDiscoveryError,
): Promise<boolean> {
  const lane = job.name.startsWith('understat-player-') ? 'player' : 'team';
  return withMutationScopes(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
      scopes: lockScopes(lane, job.name, job.data),
    },
    async () => {
      const run = await understatSyncRepository.findRun(job.data.runId);
      if (!run || !ACTIVE_UNDERSTAT_RUN_STATUSES.has(run.status)) return false;
      const item =
        lane === 'player'
          ? understatPlayerItemForJob(job.data as UnderstatPlayerJobData, job.name)
          : understatTeamItemForJob(job.data as UnderstatTeamJobData, job.name);
      const expectedAttempt = claimedAttempts.get(job);
      if (item && expectedAttempt !== undefined) {
        const persisted = await understatSyncRepository.findItem(
          job.data.runId,
          item.resourceType,
          item.resourceId,
        );
        if (persisted?.attempts !== expectedAttempt) return false;
      }
      // The completed league payload cannot become fresh by retrying a detail.
      // Ending this run fences in-flight writes; the existing scheduler retry
      // creates a new run and distinct BullMQ IDs with a fresh league fetch.
      await understatSyncRepository.markRunFailed(job.data.runId, error.message);
      return true;
    },
  );
}

async function recordTerminalFailure(
  job: Job<UnderstatTeamJobData | UnderstatPlayerJobData>,
  error: unknown,
): Promise<void> {
  const terminal = isTerminalJobAttemptFailure(job, error, job.attemptsMade + 1);
  if (!terminal && !(error instanceof SupersededUnderstatDiscoveryError)) return;
  const typedError = error instanceof Error ? error : new Error(String(error));
  try {
    const currentAttempt =
      error instanceof SupersededUnderstatDiscoveryError
        ? await retireSupersededDiscoveryRun(job, error)
        : job.name.startsWith('understat-player-')
          ? await recordPlayerFailure(job as Job<UnderstatPlayerJobData>, typedError, true)
          : await recordTeamFailure(job as Job<UnderstatTeamJobData>, typedError, true);
    if (currentAttempt && understatFailureBookkeepingPlan(job.data).settleScheduler) {
      await settleUnderstatFailureAfterRunDrained(job, typedError, true);
    }
  } catch (bookkeepingError) {
    logError('Understat terminal failure bookkeeping failed in worker path', bookkeepingError, {
      runId: job.data.runId,
      jobId: job.id,
    });
  }
}

export function createUnderstatWorker(): WorkerRuntime {
  if (!getConfig().UNDERSTAT_ENABLED) {
    logInfo('Understat workers disabled by feature flag');
    return { workers: [], queueEvents: [], monitorTargets: [] };
  }

  const connection = getQueueConnection();
  const understatTeamQueue = getUnderstatTeamQueue();
  const understatPlayerQueue = getUnderstatPlayerQueue();
  const teamWorker = new Worker<UnderstatTeamJobData>(understatTeamQueueName, processTeamJob, {
    connection,
    concurrency: 2,
    lockDuration: 120_000,
    maxStalledCount: 2,
    settings: { backoffStrategy: understatBackoff },
  });
  const playerWorker = new Worker<UnderstatPlayerJobData>(
    understatPlayerQueueName,
    processPlayerJob,
    {
      connection,
      concurrency: 2,
      lockDuration: 120_000,
      maxStalledCount: 2,
      settings: { backoffStrategy: understatBackoff },
    },
  );
  const teamEvents = new QueueEvents(understatTeamQueueName, { connection });
  const playerEvents = new QueueEvents(understatPlayerQueueName, { connection });

  teamWorker.on('completed', (job) => {
    logInfo('Understat team job completed', { jobId: job.id, name: job.name });
  });
  playerWorker.on('completed', (job) => {
    logInfo('Understat player job completed', { jobId: job.id, name: job.name });
  });
  teamWorker.on('failed', (job, error) => {
    logError('Understat team job failed', error, {
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
    });
    if (job) {
      if (isTerminalJobFailure(job, error)) {
        void recordTerminalFailure(job, error);
      }
      void alertOnFinalFailure(job, error);
    }
  });
  playerWorker.on('failed', (job, error) => {
    logError('Understat player job failed', error, {
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
    });
    if (job) {
      if (isTerminalJobFailure(job, error)) {
        void recordTerminalFailure(job, error);
      }
      void alertOnFinalFailure(job, error);
    }
  });

  return {
    workers: [teamWorker, playerWorker],
    queueEvents: [teamEvents, playerEvents],
    monitorTargets: [
      {
        queue: understatTeamQueue,
        queueEvents: teamEvents,
        queueName: understatTeamQueueName,
      },
      {
        queue: understatPlayerQueue,
        queueEvents: playerEvents,
        queueName: understatPlayerQueueName,
      },
    ],
  };
}
