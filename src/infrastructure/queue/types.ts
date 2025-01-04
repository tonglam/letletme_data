import { Job, Queue, Worker } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { QueueError } from '../../types/errors.type';
import { BaseJobData } from '../../types/job.type';

export interface FlowJob<T> {
  name: string;
  queueName: string;
  data: T;
  opts?: FlowOpts<T>;
  children?: FlowJob<T>[];
}

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

export type BullMQJobStatus =
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'active'
  | 'paused'
  | 'wait'
  | 'prioritized';

export interface BullMQQueueMethods<T> {
  add: (name: string, data: T, opts?: JobOptions) => Promise<Job<T>>;
  addBulk: (jobs: Array<{ name: string; data: T; opts?: JobOptions }>) => Promise<Job<T>[]>;
}

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
