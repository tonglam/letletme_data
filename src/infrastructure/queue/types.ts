import { FlowJob as BullMQFlowJob, FlowOpts, JobsOptions, Queue, Worker } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { QueueError } from '../../types/errors.type';
import { BaseJobData } from '../../types/queue.type';

// BullMQ job status type
export type BullMQJobStatus =
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'active'
  | 'paused'
  | 'wait'
  | 'prioritized';

// Job Options (extends BullMQ's JobsOptions)
export type JobOptions = JobsOptions;

// BullMQ Queue Method Types
export interface BullMQQueueMethods<T> {
  add(name: string, data: T, opts?: JobsOptions): Promise<void>;
  addBulk(jobs: Array<{ name: string; data: T; opts?: JobsOptions }>): Promise<void>;
}

// Job Scheduler Types
export interface JobSchedulerOptions {
  readonly every?: number;
  readonly pattern?: string; // cron pattern
}

export interface JobScheduler {
  readonly id: string;
  readonly name: string;
  readonly options: JobSchedulerOptions;
  readonly nextRun?: Date;
  readonly template?: JobTemplate<BaseJobData>;
}

export interface JobTemplate<T extends BaseJobData> {
  readonly name?: string;
  readonly data?: T;
  readonly opts?: JobOptions;
}

export interface SchedulerService<T extends BaseJobData> {
  // Create or update a job scheduler
  readonly upsertJobScheduler: (
    schedulerId: string,
    scheduleOptions: JobSchedulerOptions,
    template?: JobTemplate<T>,
  ) => TE.TaskEither<QueueError, void>;

  // Get all job schedulers with pagination
  readonly getJobSchedulers: (
    start?: number,
    end?: number,
    asc?: boolean,
  ) => TE.TaskEither<QueueError, JobScheduler[]>;
}

// Queue Service interface
export interface QueueService<T extends BaseJobData> {
  // Core operations
  readonly addJob: (data: T, options?: JobOptions) => TE.TaskEither<QueueError, void>;
  readonly addBulk: (
    jobs: Array<{ data: T; options?: JobOptions }>,
  ) => TE.TaskEither<QueueError, void>;

  // Job Scheduler operations
  readonly upsertJobScheduler: SchedulerService<T>['upsertJobScheduler'];
  readonly getJobSchedulers: SchedulerService<T>['getJobSchedulers'];

  // Job removal operations
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
  readonly drain: () => TE.TaskEither<QueueError, void>;
  readonly clean: (
    gracePeriod: number,
    limit: number,
    status: BullMQJobStatus,
  ) => TE.TaskEither<QueueError, string[]>;
  readonly obliterate: () => TE.TaskEither<QueueError, void>;

  // Queue control operations
  readonly pause: () => TE.TaskEither<QueueError, void>;
  readonly resume: () => TE.TaskEither<QueueError, void>;

  // Access to underlying queue for advanced operations
  readonly getQueue: () => Queue<T>;
}

// Worker Options
export interface WorkerOptions {
  readonly concurrency?: number;
}

// Worker Service interface
export interface WorkerService<T extends BaseJobData> {
  readonly getWorker: () => Worker<T>;
  readonly setConcurrency: (value: number) => void;
  readonly close: () => TE.TaskEither<QueueError, void>;
  readonly pause: (force?: boolean) => TE.TaskEither<QueueError, void>;
  readonly resume: () => TE.TaskEither<QueueError, void>;
}

// BullMQ Flow Types
export interface BullMQFlowDependency {
  readonly name: string;
  readonly queueName: string;
  readonly data: unknown;
  readonly opts?: Record<string, unknown>;
}

// Flow Types
export interface FlowJobOptions extends Omit<JobsOptions, 'parent' | 'repeat'> {
  readonly priority?: number;
  readonly delay?: number;
  readonly attempts?: number;
  readonly backoff?: number | { type: string; delay: number };
  readonly lifo?: boolean;
  readonly timeout?: number;
  readonly removeOnComplete?: boolean | number;
  readonly removeOnFail?: boolean | number;
  readonly stackTraceLimit?: number;
}

export interface FlowJob<T extends BaseJobData>
  extends Omit<BullMQFlowJob, 'data' | 'opts' | 'children'> {
  readonly data?: T;
  readonly opts?: FlowJobOptions;
  readonly children?: FlowJob<T>[];
}

export interface QueueOptions {
  readonly defaultJobOptions?: JobsOptions;
  readonly settings?: Record<string, unknown>;
}

export interface FlowProducerOptions extends FlowOpts {}

export interface FlowService<T extends BaseJobData> {
  // Add a flow of jobs with parent-child relationships
  readonly addFlow: (
    flow: FlowJob<T>,
    options?: FlowProducerOptions,
  ) => TE.TaskEither<QueueError, void>;

  // Add multiple flows atomically
  readonly addBulkFlows: (flows: FlowJob<T>[]) => TE.TaskEither<QueueError, void>;

  // Remove a flow (parent and all children)
  readonly removeFlow: (jobId: string) => TE.TaskEither<QueueError, boolean>;

  // Remove multiple flows atomically
  readonly removeBulkFlows: (jobIds: string[]) => TE.TaskEither<QueueError, boolean>;

  // Get flow dependencies
  readonly getFlowDependencies: (jobId: string) => TE.TaskEither<QueueError, FlowJob<T>[]>;

  // Get children values for a parent job
  readonly getChildrenValues: (jobId: string) => TE.TaskEither<QueueError, Record<string, unknown>>;
}
