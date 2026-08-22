import { Queue, QueueEvents, Worker, type Job } from 'bullmq';

import type { ClaimedAcquisitionJobOutbox } from '../acquisition/job-outbox';
import { acquisitionJobV1Schema, type AcquisitionJobV1 } from '../acquisition/formal-run-contract';
import type { ClaimedFormalRun } from '../acquisition/formal-run-repository';
import { getContentRuntimeFlags } from '../config';
import { logError, logInfo } from '../../utils/logger';
import { getQueueConnection } from '../../utils/queue';
import { runFormalHttpWorker } from './formal-http.worker';

export const contentHttpAcquisitionQueueName = 'content-http-acquisition';

let queue: Queue<AcquisitionJobV1> | null = null;

export function getContentHttpAcquisitionQueue(): Queue<AcquisitionJobV1> {
  queue ??= new Queue<AcquisitionJobV1>(contentHttpAcquisitionQueueName, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 172_800, count: 1_000 },
    },
  });
  return queue;
}

export async function enqueueFormalHttpRun(
  claimed: Pick<ClaimedFormalRun | ClaimedAcquisitionJobOutbox, 'job' | 'jobId' | 'priority'>,
): Promise<Job<AcquisitionJobV1>> {
  const job = acquisitionJobV1Schema.parse(claimed.job);
  return getContentHttpAcquisitionQueue().add('content-http-acquisition', job, {
    jobId: claimed.jobId,
    priority: claimed.priority,
  });
}

export function createFormalHttpWorkerRuntime() {
  const flags = getContentRuntimeFlags();
  const connection = getQueueConnection();
  const worker = new Worker<AcquisitionJobV1>(
    contentHttpAcquisitionQueueName,
    async (job) => runFormalHttpWorker(acquisitionJobV1Schema.parse(job.data)),
    { connection, concurrency: flags.httpConcurrency },
  );
  const queueEvents = new QueueEvents(contentHttpAcquisitionQueueName, { connection });
  worker.on('completed', (job) =>
    logInfo('Formal HTTP acquisition job completed', { jobId: job.id, runId: job.data.runId }),
  );
  worker.on('failed', (job, error) =>
    logError('Formal HTTP acquisition job failed', error, {
      jobId: job?.id,
      runId: job?.data.runId,
    }),
  );
  worker.on('error', (error) => logError('Formal HTTP worker runtime error', error));
  return { worker, queueEvents };
}

export async function closeContentHttpAcquisitionQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}
