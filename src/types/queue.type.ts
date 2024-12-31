import { Job, Queue, Worker } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { RedisOptions } from 'ioredis';
import { MetaJobType } from '../queues/jobs/core/meta.job';
import { QueueError } from './errors.type';

export enum JobStatus {
  COMPLETED = 'completed',
  FAILED = 'failed',
  ACTIVE = 'active',
  DELAYED = 'delayed',
  PRIORITIZED = 'prioritized',
  PAUSED = 'paused',
  WAITING = 'wait',
}

// Job Type Enums
export enum JobType {
  META = 'meta',
  LIVE = 'live',
  POST_MATCH = 'post-match',
  DAILY = 'daily',
}

export enum JobOperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
}

// Base Job Types
export interface BaseJobData {
  readonly type: JobType;
  readonly timestamp: Date;
  readonly data: Record<string, unknown>;
}

export interface JobOptions {
  readonly priority?: number;
  readonly attempts?: number;
  readonly backoff?: {
    readonly type: 'exponential' | 'fixed';
    readonly delay: number;
  };
  readonly timeout?: number;
  readonly removeOnComplete?: boolean | number;
  readonly removeOnFail?: boolean | number;
}

// Queue Configuration Types
export interface QueueConfig {
  readonly name: string;
  readonly prefix: string;
  readonly connection: RedisOptions;
}

// Queue and Worker Adapter Types
export interface QueueAdapter {
  readonly queue: Queue;
  readonly addJob: <T extends BaseJobData>(data: T) => TE.TaskEither<QueueError, Job<T>>;
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
  readonly pauseQueue: () => TE.TaskEither<QueueError, void>;
  readonly resumeQueue: () => TE.TaskEither<QueueError, void>;
  readonly cleanQueue: (options?: QueueCleanupOptions) => TE.TaskEither<QueueError, void>;
}

export interface WorkerAdapter<T extends BaseJobData = BaseJobData> {
  readonly worker: Worker<T, void, string>;
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
  readonly isRunning: () => boolean;
}

// Worker State Types
export interface WorkerStateData {
  currentState: string;
  isRunning: boolean;
  isClosing: boolean;
  lastError: Error | null;
  lastStateChange: Date;
  stateHistory: Array<{
    from: string;
    to: string;
    timestamp: Date;
    error?: string;
  }>;
}

export interface WorkerState extends Readonly<WorkerStateData> {}

export interface WorkerContext<T extends BaseJobData = BaseJobData> {
  readonly worker: Worker<T, void, string>;
  readonly state: WorkerState;
}

// Registry and Environment Types
export type QueueRegistry = Record<JobType, QueueAdapter>;
export type QueueEnv = { readonly registry: QueueRegistry };
export type WorkerRegistry = Record<JobType, WorkerAdapter>;
export type WorkerEnv = { readonly registry: WorkerRegistry };

// Job Processor Types
export type JobProcessor<T extends BaseJobData> = (
  job: Job<T>,
) => TE.TaskEither<Error | QueueError, void>;

// Specific Job Data Types
export interface MetaJobData extends BaseJobData {
  readonly type: JobType.META;
  readonly data: {
    readonly operation: JobOperationType;
    readonly id?: number;
    readonly type: MetaJobType;
  };
}

export interface LiveJobData extends BaseJobData {
  readonly type: JobType.LIVE;
  readonly data: {
    readonly matchId?: number;
    readonly gameweek?: number;
  };
}

export interface PostMatchJobData extends BaseJobData {
  readonly type: JobType.POST_MATCH;
  readonly data: {
    readonly matchId: number;
    readonly gameweek: number;
  };
}

export interface DailyJobData extends BaseJobData {
  readonly type: JobType.DAILY;
  readonly data: {
    readonly date: string;
    readonly options?: Record<string, unknown>;
  };
}

// Queue Cleanup Types
export interface QueueCleanupOptions {
  readonly age?: number;
  readonly limit?: number;
  readonly status?: JobStatus;
}

// Union type for all job data types
export type JobData = MetaJobData | LiveJobData | PostMatchJobData | DailyJobData;
