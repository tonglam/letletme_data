import type { Queue, QueueEvents, Worker } from 'bullmq';

import type { MutationPriorityTier } from '../domain/job-priority';

export interface QueueMonitorTarget {
  queue: Queue;
  queueEvents: QueueEvents;
  queueName: string;
  tier?: MutationPriorityTier;
}

export interface WorkerRuntime {
  workers: Worker[];
  queueEvents: QueueEvents[];
  monitorTargets: QueueMonitorTarget[];
  stop?: () => void;
}
