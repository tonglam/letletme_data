import { ConnectionOptions, JobsOptions, JobType } from 'bullmq';
import { QueueOptions } from 'src/infrastructures/queue/types';

// Queue progress constants
export const QUEUE_PROGRESS = {
  START: 0,
  COMPLETE: 100,
} as const;

// Queue job types
export const QUEUE_JOB_TYPES = {
  BOOTSTRAP: 'BOOTSTRAP',
  PHASES: 'PHASES',
  EVENTS: 'EVENTS',
  TEAMS: 'TEAMS',
} as const;

// Queue job priorities
export const QUEUE_PRIORITIES = {
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
} as const;

// Queue job attempts
export const QUEUE_ATTEMPTS = {
  BOOTSTRAP: 5,
  DEFAULT: 3,
} as const;

// Queue job states
export const QUEUE_JOB_STATES: Record<string, JobType[]> = {
  PENDING: ['waiting', 'active', 'delayed'],
  FAILED: ['failed'],
  COMPLETED: ['completed'],
};

// Queue logging constants
export const QUEUE_LOG_MESSAGES = {
  JOB_COMPLETED: (jobId: string, queueName: string) =>
    `${queueName} job ${jobId} completed successfully`,
  JOB_FAILED: (jobId: string, queueName: string) => `${queueName} job ${jobId} failed with error:`,
  WORKER_ERROR: (queueName: string) => `${queueName} worker error:`,
  JOB_DATA: 'Job data:',
  UNKNOWN_JOB_TYPE: (type: string) => `Unknown job type: ${type}`,
} as const;

// Default job configuration options for BullMQ
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: 100,
  removeOnFail: 100,
} as const;

// Default Redis connection options for BullMQ
export const DEFAULT_CONNECTION_OPTIONS = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times: number) => Math.min(times * 1000, 10000),
  maxRetriesPerRequest: undefined,
  enableOfflineQueue: true,
  lazyConnect: false,
} satisfies ConnectionOptions;

// Default queue configuration options
export const DEFAULT_QUEUE_OPTIONS = {
  name: 'default',
  connection: DEFAULT_CONNECTION_OPTIONS,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
} satisfies QueueOptions;

// Meta queue configuration for system-level jobs
export const META_QUEUE_CONFIG: QueueOptions = {
  name: 'meta-jobs',
  prefix: 'letletme',
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 5,
  },
  connection: DEFAULT_CONNECTION_OPTIONS,
} as const;

// Creates queue options by merging default options with custom configuration
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
