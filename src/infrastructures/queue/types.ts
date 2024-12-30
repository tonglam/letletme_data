import { Job, Queue, Worker } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { QueueCleanupOptions } from '../../configs/queue/queue.config';
import { QueueError } from '../../types/errors.type';

// Base job data interface
export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: Record<string, unknown>;
}

// Registry and Environment types
export type QueueRegistry = Record<string, QueueAdapter>;
export type QueueEnv = { readonly registry: QueueRegistry };
export type WorkerRegistry = Record<string, WorkerAdapter<BaseJobData>>;
export type WorkerEnv = { readonly registry: WorkerRegistry };

// Queue adapter interface using TaskEither
export interface QueueAdapter {
  readonly queue: Queue;
  readonly addJob: <T extends BaseJobData>(data: T) => TE.TaskEither<QueueError, Job>;
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
  readonly pauseQueue: () => TE.TaskEither<QueueError, void>;
  readonly resumeQueue: () => TE.TaskEither<QueueError, void>;
  readonly cleanQueue: (options?: QueueCleanupOptions) => TE.TaskEither<QueueError, void>;
}

// Worker adapter interface
export interface WorkerAdapter<T extends BaseJobData = BaseJobData> {
  readonly worker: Worker<T>;
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
  readonly isRunning: () => boolean;
}

// Job processor type
export type JobProcessor<T extends BaseJobData> = (job: Job<T>) => TE.TaskEither<QueueError, void>;
