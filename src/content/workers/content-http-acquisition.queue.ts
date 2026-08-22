import { Queue, QueueEvents, Worker, type Job } from 'bullmq';

import type { ClaimedAcquisitionJobOutbox } from '../acquisition/job-outbox';
import { acquisitionJobV1Schema, type AcquisitionJobV1 } from '../acquisition/formal-run-contract';
import { loadFormalRunRequest, type ClaimedFormalRun } from '../acquisition/formal-run-repository';
import { formalHttpHostKey, HostConcurrencyLimiter } from '../acquisition/host-concurrency-limiter';
import { getContentRuntimeFlags } from '../config';
import { logError, logInfo } from '../../utils/logger';
import { getQueueConnection } from '../../utils/queue';
import { runFormalHttpWorker } from './formal-http.worker';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../../queues/retention';

export const contentHttpAcquisitionQueueName = 'content-http-acquisition';

let queue: Queue<AcquisitionJobV1> | null = null;

export function getContentHttpAcquisitionQueue(): Queue<AcquisitionJobV1> {
  queue ??= new Queue<AcquisitionJobV1>(contentHttpAcquisitionQueueName, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: BULL_COMPLETED_RETENTION,
      removeOnFail: BULL_FAILED_RETENTION,
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
  const hostLimiter = new HostConcurrencyLimiter(flags.httpHostConcurrency);
  const worker = new Worker<AcquisitionJobV1>(
    contentHttpAcquisitionQueueName,
    async (job) => {
      const acquisitionJob = acquisitionJobV1Schema.parse(job.data);
      const request = await loadFormalRunRequest({ runId: acquisitionJob.runId });
      return hostLimiter.withPermit(formalHttpHostKey(request), () =>
        runFormalHttpWorker(acquisitionJob),
      );
    },
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
