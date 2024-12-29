import { Job, JobsOptions } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { BaseJobData, QueueAdapter } from '../infrastructure/queue';

// Job counts type
export interface JobCounts {
  readonly waiting: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly delayed: number;
  readonly paused: number;
}

// Job operations interface
export interface JobOperations<T extends BaseJobData> {
  readonly add: (data: T, opts?: JobsOptions) => TE.TaskEither<Error, Job<T>>;
  readonly addBulk: (
    jobs: ReadonlyArray<{ readonly data: T; readonly opts?: JobsOptions }>,
  ) => TE.TaskEither<Error, ReadonlyArray<Job<T>>>;
  readonly getJob: (jobId: string) => TE.TaskEither<Error, Job<T> | null>;
  readonly getJobCounts: () => TE.TaskEither<Error, JobCounts>;
}

// Queue management interface
export interface QueueManagement {
  readonly pause: () => TE.TaskEither<Error, void>;
  readonly resume: () => TE.TaskEither<Error, void>;
  readonly clean: (grace: number, limit: number) => TE.TaskEither<Error, number>;
  readonly close: () => TE.TaskEither<Error, void>;
}

// Queue service interface
export interface QueueService<T extends BaseJobData> extends JobOperations<T>, QueueManagement {}

// Creates a queue service
export const createQueueService = <T extends BaseJobData>(
  adapter: QueueAdapter<T>,
): QueueService<T> => ({
  // Job operations
  add: adapter.add,
  addBulk: adapter.addBulk,
  getJob: adapter.getJob,
  getJobCounts: adapter.getJobCounts,

  // Queue management
  pause: adapter.pause,
  resume: adapter.resume,
  clean: adapter.clean,
  close: adapter.close,
});
