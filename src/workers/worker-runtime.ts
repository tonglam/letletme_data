import type { Queue, QueueEvents, Worker } from 'bullmq';

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
