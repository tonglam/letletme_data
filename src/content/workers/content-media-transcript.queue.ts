import { Queue, QueueEvents, Worker, type Job } from 'bullmq';

import { acquisitionJobV1Schema, type AcquisitionJobV1 } from '../acquisition/formal-run-contract';
import type { ClaimedAcquisitionJobOutbox } from '../acquisition/job-outbox';
import { getContentRuntimeFlags } from '../config';
import { logError, logInfo } from '../../utils/logger';
import { getQueueConnection } from '../../utils/queue';
import { runFormalMediaWorker } from './formal-media.worker';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../../queues/retention';

export const contentMediaTranscriptQueueName = 'content-media-transcript';

let queue: Queue<AcquisitionJobV1> | null = null;

export function getContentMediaTranscriptQueue(): Queue<AcquisitionJobV1> {
  queue ??= new Queue<AcquisitionJobV1>(contentMediaTranscriptQueueName, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: BULL_COMPLETED_RETENTION,
      removeOnFail: BULL_FAILED_RETENTION,
    },
  });
  return queue;
}

export async function enqueueFormalMediaRun(
  claimed: Pick<ClaimedAcquisitionJobOutbox, 'job' | 'jobId' | 'priority'>,
): Promise<Job<AcquisitionJobV1>> {
  const job = acquisitionJobV1Schema.parse(claimed.job);
  return getContentMediaTranscriptQueue().add('content-media-transcript', job, {
    jobId: claimed.jobId,
    priority: claimed.priority,
  });
}

export function createFormalMediaWorkerRuntime() {
  const flags = getContentRuntimeFlags();
  const connection = getQueueConnection();
  const worker = new Worker<AcquisitionJobV1>(
    contentMediaTranscriptQueueName,
    async (job) => runFormalMediaWorker(acquisitionJobV1Schema.parse(job.data)),
    { connection, concurrency: flags.hermesTranscriptConcurrency },
  );
  const queueEvents = new QueueEvents(contentMediaTranscriptQueueName, { connection });
  worker.on('completed', (job) =>
    logInfo('Formal media transcript job completed', { jobId: job.id, runId: job.data.runId }),
  );
  worker.on('failed', (job, error) =>
    logError('Formal media transcript job failed', error, {
      jobId: job?.id,
      runId: job?.data.runId,
    }),
  );
  worker.on('error', (error) => logError('Formal media transcript worker runtime error', error));
  return { worker, queueEvents };
}

export async function closeContentMediaTranscriptQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}
