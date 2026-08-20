import { createHash } from 'node:crypto';

import { Queue, QueueEvents, Worker, type Job } from 'bullmq';

import { getQueueConnection } from '../../utils/queue';
import { logError, logInfo } from '../../utils/logger';
import { assertContentRuntimeFlags, getContentRuntimeFlags } from '../config';
import { runContentXWorker, type ContentXWorkerInput } from './content-x.worker';

export const contentXScanQueueName = 'content-x-scan';

function contentXScanJobId(
  group: string,
  partition: string,
  mode: string,
  phase: string,
  end: string,
): string {
  const key = [group, partition, mode, phase, end].join('\u001f');
  return `content-x-${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

export const contentXScanQueue = new Queue<ContentXWorkerInput>(contentXScanQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 100 },
    removeOnFail: { age: 172_800, count: 100 },
  },
});

export async function enqueueContentXScan(
  input: ContentXWorkerInput = {},
): Promise<Job<ContentXWorkerInput>> {
  const end = input.windowEnd ?? new Date().toISOString();
  const group = input.groupKey ?? process.env.CONTENT_SOURCE_GROUP_KEY ?? 'fpl-week';
  const partition = input.partitionKey ?? process.env.CONTENT_PARTITION_KEY ?? 'week';
  const mode = input.mode ?? 'poll';
  const phase = input.pollPhase ?? 'NORMAL';
  return contentXScanQueue.add('content-x-scan', input, {
    jobId: contentXScanJobId(group, partition, mode, phase, end),
  });
}

export function createContentXWorkerRuntime() {
  const connection = getQueueConnection();
  const flags = getContentRuntimeFlags();
  assertContentRuntimeFlags(flags);
  const worker = new Worker<ContentXWorkerInput>(
    contentXScanQueueName,
    async (job) => runContentXWorker(job.data),
    { connection, concurrency: flags.grokConcurrency },
  );
  const queueEvents = new QueueEvents(contentXScanQueueName, { connection });
  worker.on('completed', (job) => logInfo('Content X scan job completed', { jobId: job.id }));
  worker.on('failed', (job, error) =>
    logError('Content X scan job failed', error, { jobId: job?.id }),
  );
  worker.on('error', (error) => logError('Content X worker runtime error', error));
  return {
    worker,
    queueEvents,
    stop: () => undefined,
  };
}

export async function closeContentXQueue(): Promise<void> {
  await contentXScanQueue.close();
}
