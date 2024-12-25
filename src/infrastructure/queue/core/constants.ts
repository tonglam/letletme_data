import { JobType } from 'bullmq';

/**
 * Queue progress constants
 */
export const QUEUE_PROGRESS = {
  START: 0,
  COMPLETE: 100,
} as const;

/**
 * Queue job types
 */
export const QUEUE_JOB_TYPES = {
  BOOTSTRAP: 'BOOTSTRAP',
  PHASES: 'PHASES',
  EVENTS: 'EVENTS',
  TEAMS: 'TEAMS',
} as const;

/**
 * Queue job priorities
 */
export const QUEUE_PRIORITIES = {
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
} as const;

/**
 * Queue job attempts
 */
export const QUEUE_ATTEMPTS = {
  BOOTSTRAP: 5,
  DEFAULT: 3,
} as const;

/**
 * Queue job states
 */
export const QUEUE_JOB_STATES: Record<string, JobType[]> = {
  PENDING: ['waiting', 'active', 'delayed'],
  FAILED: ['failed'],
  COMPLETED: ['completed'],
};

/**
 * Queue logging constants
 */
export const QUEUE_LOG_MESSAGES = {
  JOB_COMPLETED: (jobId: string, queueName: string) =>
    `${queueName} job ${jobId} completed successfully`,
  JOB_FAILED: (jobId: string, queueName: string) => `${queueName} job ${jobId} failed with error:`,
  WORKER_ERROR: (queueName: string) => `${queueName} worker error:`,
  JOB_DATA: 'Job data:',
  UNKNOWN_JOB_TYPE: (type: string) => `Unknown job type: ${type}`,
} as const;
