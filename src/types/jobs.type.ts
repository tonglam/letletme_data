import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { CronJob } from 'cron';
import * as E from 'fp-ts/Either';

// Queue types
export type QueueName = 'default' | 'meta' | 'users' | 'notifications';
export type QueuePriority = 'low' | 'medium' | 'high' | 'critical';

// Job types
export interface JobMetadata {
  queue: QueueName;
  priority: QueuePriority;
  schedule?: string;
  timeout?: number;
}

export interface JobOptions {
  priority?: QueuePriority;
  attempts?: number;
  backoff?: {
    type: 'exponential' | 'fixed';
    delay: number;
  };
}

export interface JobResult<T = unknown> {
  success: boolean;
  data: T;
  error?: Error;
}

export type JobHandler<TData, TResult> = (data: TData) => Promise<E.Either<Error, TResult>>;

export interface JobDefinition<TData = unknown, TResult = unknown> {
  readonly metadata: JobMetadata;
  readonly validate?: (data: unknown) => E.Either<Error, TData>;
  readonly handler: JobHandler<TData, TResult>;
  readonly onComplete?: (result: TResult) => Promise<void>;
  readonly onFailed?: (error: Error) => Promise<void>;
}

// Service types
export interface JobServiceState {
  readonly queues: Partial<Record<QueueName, Queue>>;
  readonly workers: Partial<Record<QueueName, Worker>>;
  readonly queueEvents: Partial<Record<QueueName, QueueEvents>>;
  readonly jobDefinitions: Record<string, JobDefinition>;
}

// Scheduler types
export interface JobStatus {
  readonly registered: boolean;
  readonly running: boolean;
  readonly schedule?: string;
}

export interface SchedulerState {
  readonly cronJobs: Record<string, CronJob>;
}

// Re-export BullMQ types
export type { Job, Queue, QueueEvents, Worker };
// Re-export cron types
export type { CronJob };
