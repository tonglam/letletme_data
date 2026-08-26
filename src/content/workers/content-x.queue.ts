import { Queue, QueueEvents, Worker, type Job } from 'bullmq';

import { HostGrokRunnerClient } from '../acquisition/host-grok-runner-client';
import type { ClaimedAcquisitionJobOutbox } from '../acquisition/job-outbox';
import type { XBudgetPolicy } from '../acquisition/x-budget';
import { acquisitionJobV1Schema, type AcquisitionJobV1 } from '../acquisition/formal-run-contract';
import type { ClaimedFormalRun } from '../acquisition/formal-run-repository';
import { getContentRuntimeFlags } from '../config';
import { logError, logInfo } from '../../utils/logger';
import { getQueueConnection } from '../../utils/queue';
import { runFormalXWorker, type GrokBuildExecutorLike } from './formal-x.worker';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../../queues/retention';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../../services/queue-governance.service';

export const contentXScanQueueName = 'content-x-scan';

let queue: Queue<AcquisitionJobV1> | null = null;

export function getContentXScanQueue(): Queue<AcquisitionJobV1> {
  queue ??= new Queue<AcquisitionJobV1>(contentXScanQueueName, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: BULL_COMPLETED_RETENTION,
      removeOnFail: BULL_FAILED_RETENTION,
    },
  });
  return queue;
}

export async function enqueueFormalXRun(
  claimed: Pick<ClaimedFormalRun | ClaimedAcquisitionJobOutbox, 'job' | 'jobId' | 'priority'>,
): Promise<Job<AcquisitionJobV1>> {
  if (await isQueueDrainOnly(contentXScanQueueName)) {
    throw new QueueDrainOnlyError(contentXScanQueueName);
  }
  const job = acquisitionJobV1Schema.parse(claimed.job);
  const queue = getContentXScanQueue();
  const existing = await queue.getJob(claimed.jobId);
  if (existing) {
    if (existing.data.runId !== job.runId) {
      throw new Error(`Content X queue job ID collision for ${claimed.jobId}`);
    }
    return existing;
  }

  await queue.add('content-x-scan', job, {
    jobId: claimed.jobId,
    priority: claimed.priority,
  });

  // Queue.add returns a Job object built from the supplied payload even when
  // Redis retained a different payload for a reused jobId.  Read the
  // persisted record back before confirming the durable hand-off.
  const persisted = await queue.getJob(claimed.jobId);
  if (!persisted || persisted.data.runId !== job.runId) {
    throw new Error(`Content X queue job ID collision for ${claimed.jobId}`);
  }
  return persisted;
}

export function createConfiguredHostGrokRunner(): HostGrokRunnerClient {
  const flags = getContentRuntimeFlags();
  return new HostGrokRunnerClient({
    socketPath: flags.grokRunnerSocket,
    expectedVersion: flags.grokExpectedVersion,
    expectedRunnerReleaseSha: flags.grokRunnerReleaseSha,
    timeoutMs: flags.grokTimeoutMs,
    maximumResponseBytes: flags.grokMaxOutputBytes,
  });
}

export function createFormalXWorkerRuntime(
  executor: GrokBuildExecutorLike = createConfiguredHostGrokRunner(),
  xBudgetPolicy?: XBudgetPolicy,
) {
  const connection = getQueueConnection();
  const worker = new Worker<AcquisitionJobV1>(
    contentXScanQueueName,
    async (job) =>
      runFormalXWorker(acquisitionJobV1Schema.parse(job.data), {
        executor,
        xBudgetPolicy,
      }),
    { connection, concurrency: getContentRuntimeFlags().grokConcurrency },
  );
  const queueEvents = new QueueEvents(contentXScanQueueName, { connection });
  worker.on('completed', (job) =>
    logInfo('Formal Grok Build X job completed', { jobId: job.id, runId: job.data.runId }),
  );
  worker.on('failed', (job, error) =>
    logError('Formal Grok Build X job failed', error, {
      jobId: job?.id,
      runId: job?.data.runId,
    }),
  );
  worker.on('error', (error) => logError('Formal Grok Build X worker runtime error', error));
  return { worker, queueEvents, executor };
}

export async function closeContentXQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}
