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
import { understatSyncRepository } from '../repositories/understat-sync';
import { getConfig } from '../utils/config';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { logError, logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';
import { alertOnFinalFailure } from '../utils/notify';
import { getQueueConnection } from '../utils/queue';
import { isTerminalJobFailure } from '../utils/worker-failure';
import type { WorkerRuntime } from './worker-runtime';

function lockScopes(
  lane: 'team' | 'player',
  name: string,
  data: UnderstatTeamJobData | UnderstatPlayerJobData,
): string[] {
  const scopes = ['understat:reference:all', `understat:reference:${data.season}`];
  if (name.endsWith('-discover') || name.endsWith('-finalize')) return scopes;
  const resourceId =
    lane === 'team'
      ? (data as UnderstatTeamJobData).teamId
      : (data as UnderstatPlayerJobData).resourceId;
  return [...scopes, `understat:${lane}:${data.season}:${name}:${resourceId ?? 'unknown'}`];
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

async function processTeamJob(job: Job<UnderstatTeamJobData>): Promise<void> {
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data.trigger,
    attempt: job.attemptsMade + 1,
  };
  logJobTriggered(context);
  await withMutationScopes(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
      scopes: lockScopes('team', job.name, job.data),
    },
    () =>
      runTrackedJob(context, () =>
        runUnderstatOperation(async () => {
          switch (job.name) {
            case 'understat-team-discover':
              return discoverUnderstatTeams(job.data);
            case 'understat-team-detail':
              return syncUnderstatTeamDetail(job.data);
            case 'understat-team-finalize':
              return finalizeUnderstatTeamRun(job.data);
            default:
              throw new Error(`Unknown Understat team job: ${job.name}`);
          }
        }),
      ),
  );
}

async function processPlayerJob(job: Job<UnderstatPlayerJobData>): Promise<void> {
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data.trigger,
    attempt: job.attemptsMade + 1,
  };
  logJobTriggered(context);
  await withMutationScopes(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
      scopes: lockScopes('player', job.name, job.data),
    },
    () =>
      runTrackedJob(context, () =>
        runUnderstatOperation(async () => {
          switch (job.name) {
            case 'understat-player-discover':
              return discoverUnderstatPlayers(job.data);
            case 'understat-player-team-detail':
              return syncUnderstatPlayerTeamDetail(job.data);
            case 'understat-player-match':
              return syncUnderstatPlayerMatch(job.data);
            case 'understat-player-finalize':
              return finalizeUnderstatPlayerRun(job.data);
            default:
              throw new Error(`Unknown Understat player job: ${job.name}`);
          }
        }),
      ),
  );
}

async function recordTeamFailure(job: Job<UnderstatTeamJobData>, error: Error): Promise<void> {
  if (!isTerminalJobFailure(job, error)) return;
  const item = understatTeamItemForJob(job.data, job.name);
  if (item) {
    const persisted = await understatSyncRepository.findItem(
      job.data.runId,
      item.resourceType,
      item.resourceId,
    );
    if (persisted?.status === 'completed' || persisted?.status === 'skipped') {
      await understatSyncRepository.markRunFailed(job.data.runId, error.message);
      return;
    }
    await understatSyncRepository.failItem(
      job.data.runId,
      item.resourceType,
      item.resourceId,
      error.message,
    );
    return;
  }
  await understatSyncRepository.markRunFailed(job.data.runId, error.message);
}

async function recordPlayerFailure(job: Job<UnderstatPlayerJobData>, error: Error): Promise<void> {
  if (!isTerminalJobFailure(job, error)) return;
  const item = understatPlayerItemForJob(job.data, job.name);
  if (item) {
    const persisted = await understatSyncRepository.findItem(
      job.data.runId,
      item.resourceType,
      item.resourceId,
    );
    if (persisted?.status === 'completed' || persisted?.status === 'skipped') {
      await understatSyncRepository.markRunFailed(job.data.runId, error.message);
      return;
    }
    await understatSyncRepository.failItem(
      job.data.runId,
      item.resourceType,
      item.resourceId,
      error.message,
    );
    return;
  }
  await understatSyncRepository.markRunFailed(job.data.runId, error.message);
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
      void recordTeamFailure(job, error).catch((bookkeepingError) =>
        logError('Understat team failure bookkeeping failed', bookkeepingError, {
          runId: job.data.runId,
        }),
      );
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
      void recordPlayerFailure(job, error).catch((bookkeepingError) =>
        logError('Understat player failure bookkeeping failed', bookkeepingError, {
          runId: job.data.runId,
        }),
      );
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
