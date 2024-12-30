// Queue Types Module
//
// Defines core types and interfaces for the queue infrastructure.
// Includes job data structures, queue operations, and monitoring interfaces.

import { ConnectionOptions, Job, JobsOptions, Queue, QueueEvents } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';

// Job types
export type JobType = string | 'waiting' | 'active' | 'delayed' | 'paused' | 'completed' | 'failed';

// Job counts interface
export interface JobCounts {
  readonly waiting: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly delayed: number;
  readonly paused: number;
}

// Enhanced error types
export interface QueueError extends Error {
  readonly queueName: string;
  readonly operation: string;
  readonly cause?: Error;
}

// Base job data that all jobs must extend
export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly priority?: number;
}

// Common job operations
export enum JobOperation {
  UPDATE = 'UPDATE',
  SYNC = 'SYNC',
  DELETE = 'DELETE',
}

// Common job options
export interface JobOptions {
  readonly forceUpdate?: boolean;
  readonly validateOnly?: boolean;
  readonly targetIds?: ReadonlyArray<number>;
}

// Worker metrics
export interface WorkerMetrics {
  readonly processedCount: number;
  readonly failedCount: number;
  readonly activeCount: number;
  readonly completedCount: number;
  readonly stallCount: number;
  readonly waitTimeAvg: number;
}

// Enhanced worker dependencies
export interface WorkerDependencies<T extends BaseJobData> {
  readonly process: (job: Job<T>) => TE.TaskEither<Error, void>;
  readonly onCompleted?: (job: Job<T>) => void;
  readonly onFailed?: (job: Job<T>, error: Error) => void;
  readonly onError?: (error: Error) => void;
  readonly onProgress?: (job: Job<T>, progress: number) => void;
  readonly onStalled?: (job: Job<T>) => void;
}

// Queue options type with rate limiting
export interface QueueOptions {
  readonly name: string;
  readonly prefix?: string;
  readonly connection: ConnectionOptions;
  readonly defaultJobOptions?: JobsOptions;
  readonly rateLimit?: {
    readonly max: number;
    readonly duration: number;
  };
  readonly monitoring?: {
    readonly enabled: boolean;
    readonly metricsInterval: number;
  };
}

// Queue dependencies
export interface QueueDependencies {
  readonly queue: Queue;
  readonly events: QueueEvents;
}

// Enhanced queue adapter interface
export interface EnhancedQueueAdapter<T extends BaseJobData> {
  readonly add: (data: T, opts?: JobsOptions) => TE.TaskEither<QueueError, Job<T>>;
  readonly addBulk: (
    jobs: ReadonlyArray<{ readonly data: T; readonly opts?: JobsOptions }>,
  ) => TE.TaskEither<QueueError, ReadonlyArray<Job<T>>>;
  readonly getJobs: (
    types: string[],
    start?: number,
    end?: number,
  ) => TE.TaskEither<QueueError, Job<T>[]>;
  readonly getWaitingCount: () => TE.TaskEither<QueueError, number>;
  readonly removeJobs: (pattern: string) => TE.TaskEither<QueueError, void>;
  readonly drain: () => TE.TaskEither<QueueError, void>;
  readonly pause: () => TE.TaskEither<QueueError, void>;
  readonly resume: () => TE.TaskEither<QueueError, void>;
  readonly clean: (grace: number, limit: number) => TE.TaskEither<QueueError, number>;
  readonly close: () => TE.TaskEither<QueueError, void>;
  readonly getJob: (jobId: string) => TE.TaskEither<QueueError, Job<T> | null>;
  readonly getJobCounts: () => TE.TaskEither<QueueError, JobCounts>;
}

// Enhanced worker adapter interface
export interface EnhancedWorkerAdapter {
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
  readonly isRunning: () => boolean;
  readonly getMetrics: () => TE.TaskEither<QueueError, WorkerMetrics>;
  readonly pause: () => TE.TaskEither<QueueError, void>;
  readonly resume: () => TE.TaskEither<QueueError, void>;
}

// Meta job data type
export interface MetaJobData extends BaseJobData {
  readonly type: 'BOOTSTRAP' | 'PHASES' | 'EVENTS' | 'TEAMS';
  readonly data: {
    readonly operation: JobOperation;
    readonly id?: number;
    readonly options?: JobOptions;
  };
}

// Monitor metrics for a queue
export interface QueueMetrics {
  readonly activeJobs: number;
  readonly waitingJobs: number;
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly delayedJobs: number;
  readonly processingTime: number;
  readonly errorRate: number;
  readonly throughput: number;
}

// Job status type
export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed';

// Monitor metrics for a job
export interface JobMetricsData {
  readonly jobId: string;
  readonly type: string;
  readonly status: JobStatus;
  readonly duration: number;
  readonly attempts: number;
  readonly timestamp: Date;
  readonly progress: number;
}

// Mutable job metrics for internal use
export interface MutableJobMetrics {
  status: JobStatus;
  duration: number;
  progress: number;
  readonly jobId: string;
  readonly type: string;
  readonly attempts: number;
  readonly timestamp: Date;
}

// Monitor configuration
export interface MonitorConfig {
  readonly metricsInterval: number;
  readonly historySize: number;
}

// Monitor operations interface
export interface MonitorOperations {
  readonly start: () => TE.TaskEither<Error, void>;
  readonly stop: () => TE.TaskEither<Error, void>;
  readonly getMetrics: () => TE.TaskEither<Error, QueueMetrics>;
  readonly getJobMetrics: (jobId: string) => TE.TaskEither<Error, JobMetricsData | null>;
}

// Monitor dependencies
export interface MonitorDependencies {
  readonly queue: Queue;
  readonly events: QueueEvents;
  readonly logger: Logger;
  readonly config?: MonitorConfig;
}

// Queue event data types
export interface QueueEventData {
  active: { jobId: string; type: string; timestamp: Date };
  completed: { jobId: string; returnvalue: string };
  failed: { jobId: string; failedReason: string };
  progress: { jobId: string; data: number };
}

// Queue event listener type
export type QueueEventListener<K extends keyof QueueEventData> = (data: QueueEventData[K]) => void;

// Queue event emitter type
export type QueueEventEmitter = {
  on<K extends keyof QueueEventData>(event: K, listener: QueueEventListener<K>): void;
  emit<K extends keyof QueueEventData>(event: K, data: QueueEventData[K]): boolean;
};
