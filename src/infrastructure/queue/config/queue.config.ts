import { ConnectionOptions, JobsOptions } from 'bullmq';
import { QueueOptions } from '../types';

/**
 * Default job options
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: 100,
  removeOnFail: 100,
} as const;

/**
 * Default connection options
 */
export const DEFAULT_CONNECTION_OPTIONS = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times: number) => Math.min(times * 1000, 10000),
} satisfies ConnectionOptions;

/**
 * Default queue options
 */
export const DEFAULT_QUEUE_OPTIONS = {
  name: 'default',
  connection: DEFAULT_CONNECTION_OPTIONS,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
} satisfies QueueOptions;

/**
 * Meta queue configuration
 */
export const META_QUEUE_CONFIG: QueueOptions = {
  name: 'meta-jobs',
  prefix: 'letletme',
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 5, // More attempts for meta jobs
  },
  connection: DEFAULT_CONNECTION_OPTIONS,
} as const;

/**
 * Creates queue options with custom configuration
 */
export const createQueueOptions = (options: Partial<QueueOptions>): QueueOptions => ({
  ...DEFAULT_QUEUE_OPTIONS,
  ...options,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    ...options.defaultJobOptions,
  },
  connection: {
    ...DEFAULT_CONNECTION_OPTIONS,
    ...options.connection,
  },
});
