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
