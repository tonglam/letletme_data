import type { Queue, QueueEvents, Worker } from 'bullmq';

export const WORKER_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface QueueMonitorTarget {
  queue: Queue;
  queueEvents: QueueEvents;
  queueName: string;
}

export interface WorkerRuntime {
  workers: Worker[];
  queueEvents: QueueEvents[];
  monitorTargets: QueueMonitorTarget[];
  stop?: () => void;
}

/**
 * Ask every BullMQ worker to stop accepting work and drain its active job.
 * `Promise.all` is deliberately avoided: one broken Redis/socket connection
 * must not short-circuit the other workers' drain attempts before shared
 * clients are closed.
 */
export async function drainWorkers(workers: readonly Worker[]): Promise<void> {
  const settled = await Promise.allSettled(workers.map((worker) => worker.close()));
  const failures = settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} BullMQ worker(s) failed to drain`);
  }
}
