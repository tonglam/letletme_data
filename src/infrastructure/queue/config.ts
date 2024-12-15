import { QueueOptions, WorkerOptions } from 'bullmq';
import { sharedRedisConnection } from '../redis/client';
import { createBullMQConfig } from '../redis/config';

export const QUEUE_CONFIG: QueueOptions = {
  ...createBullMQConfig(sharedRedisConnection),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
} as const;

export const WORKER_CONFIG: WorkerOptions = {
  ...createBullMQConfig(sharedRedisConnection),
  lockDuration: 30000,
  stalledInterval: 30000,
  maxStalledCount: 3,
} as const;

export const QUEUE_NAMES = {
  META: 'meta-jobs',
  TIME_BASED: 'time-based-jobs',
  TOURNAMENT: 'tournament-jobs',
  HYBRID: 'hybrid-jobs',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const QUEUE_PRIORITIES = {
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
} as const;

export type QueuePriority = (typeof QUEUE_PRIORITIES)[keyof typeof QUEUE_PRIORITIES];
