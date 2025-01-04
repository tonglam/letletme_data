import { Job, Queue, Worker } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { Redis } from 'ioredis';
import { QueueError } from '../../types/errors.type';

// Base Job Data
export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: unknown;
}

// Job Status and Operation Types
export type BullMQJobStatus =
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'active'
  | 'paused'
  | 'wait'
  | 'prioritized';

export type JobOperation = 'SYNC' | 'UPDATE' | 'CLEANUP';
export type JobType = 'META' | 'LIVE' | 'DAILY';
export type MetaJobType = 'EVENTS' | 'PHASES' | 'TEAMS';

// Flow Types
export interface FlowJob<T> {
  name: string;
  queueName: string;
  data: T;
  opts?: FlowOpts<T>;
  children?: FlowJob<T>[];
}

export interface FlowJobWithParent {
  name: string;
  queueName: string;
  data: unknown;
  opts: {
    jobId: string;
    parent?: {
      id: string;
      queue: string;
    };
  };
  children?: Array<{
    name: string;
    queueName: string;
    data: unknown;
    opts: {
      jobId: string;
      parent: {
        id: string;
        queue: string;
      };
    };
  }>;
}

// Type guard for job ID
export const hasJobId = (job: { id?: string }): job is { id: string } => typeof job.id === 'string';

export interface FlowOpts<T = unknown> {
  jobId: string;
  priority?: number;
  lifo?: boolean;
  delay?: number;
  timestamp?: number;
  children?: FlowJob<T>[];
  parent?: {
    id: string;
    queue: string;
    waitChildrenKey?: string;
  };
}

// Service Interfaces
export interface FlowService<T> {
  getFlowDependencies: (jobId: string) => TE.TaskEither<QueueError, FlowJob<T>[]>;
  getChildrenValues: (jobId: string) => TE.TaskEither<QueueError, Record<string, unknown>>;
  addJob: (data: T, opts?: FlowOpts<T>) => TE.TaskEither<QueueError, FlowJob<T>>;
  close: () => Promise<void>;
}

export interface QueueService<T> {
  addJob: (data: T, options?: JobOptions) => TE.TaskEither<QueueError, void>;
  addBulk: (jobs: Array<{ data: T; options?: JobOptions }>) => TE.TaskEither<QueueError, void>;
  removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
  drain: () => TE.TaskEither<QueueError, void>;
  clean: (
    gracePeriod: number,
    limit: number,
    status: BullMQJobStatus,
  ) => TE.TaskEither<QueueError, string[]>;
  obliterate: () => TE.TaskEither<QueueError, void>;
  pause: () => TE.TaskEither<QueueError, void>;
  resume: () => TE.TaskEither<QueueError, void>;
  getQueue: () => Queue<T>;
  upsertJobScheduler: (
    jobId: string,
    options: JobSchedulerOptions,
  ) => TE.TaskEither<QueueError, void>;
  getJobSchedulers: (options?: {
    page?: number;
    pageSize?: number;
  }) => TE.TaskEither<QueueError, JobScheduler[]>;
}

// Worker Types
export interface WorkerOptions {
  concurrency?: number;
  autorun?: boolean;
  maxStalledCount?: number;
  stalledInterval?: number;
}

export interface WorkerService<T> {
  start: () => TE.TaskEither<QueueError, void>;
  stop: () => TE.TaskEither<QueueError, void>;
  getWorker: () => Worker<T>;
  close: () => TE.TaskEither<QueueError, void>;
  pause: (force?: boolean) => TE.TaskEither<QueueError, void>;
  resume: () => TE.TaskEither<QueueError, void>;
  setConcurrency: (concurrency: number) => void;
}

// Adapter Types
export interface QueueAdapter<T extends BaseJobData> {
  readonly queue: Queue;
  readonly addJob: (data: T) => TE.TaskEither<QueueError, Job<T>>;
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
}

export interface WorkerAdapter {
  readonly worker: Worker;
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
}

export interface MultiWorkerAdapter {
  readonly workers: Worker[];
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
}

export interface SequentialQueueAdapter<T extends BaseJobData> {
  readonly queues: Record<string, Queue>;
  readonly addJob: (queueName: string, data: T) => TE.TaskEither<QueueError, Job<T>>;
  readonly removeJob: (queueName: string, jobId: string) => TE.TaskEither<QueueError, void>;
}

// Job Related Types
export interface JobOptions {
  priority?: number;
  lifo?: boolean;
  delay?: number;
  repeat?: {
    pattern?: string;
    every?: number;
    limit?: number;
  };
  jobId?: string;
  timestamp?: number;
  parent?: {
    id: string;
    queue: string;
    waitChildrenKey?: string;
  };
}

export interface JobSchedulerOptions {
  pattern?: string;
  every?: number;
  limit?: number;
}

export interface JobScheduler {
  jobId: string;
  pattern?: string;
  every?: number;
  limit?: number;
  nextRun?: Date;
  lastRun?: Date;
}

export interface JobTemplate<T extends BaseJobData> {
  name?: string;
  data?: T;
  opts?: JobOptions;
}

export interface SchedulerService<T extends BaseJobData> {
  upsertJobScheduler: (
    schedulerId: string,
    scheduleOptions: JobSchedulerOptions,
    template?: JobTemplate<T>,
  ) => TE.TaskEither<QueueError, void>;
  getJobSchedulers: (options?: {
    page?: number;
    pageSize?: number;
  }) => TE.TaskEither<QueueError, JobScheduler[]>;
}

// Queue Connection Type
export type QueueConnection =
  | Redis
  | {
      host: string;
      port: number;
    };

// Job Processor Type
export type JobProcessor<T extends BaseJobData> = (job: Job<T>) => TE.TaskEither<QueueError, void>;

// BullMQ Queue Methods Interface
export interface BullMQQueueMethods<T> {
  add: (name: string, data: T, opts?: JobOptions) => Promise<Job<T>>;
  addBulk: (jobs: Array<{ name: string; data: T; opts?: JobOptions }>) => Promise<Job<T>[]>;
}
