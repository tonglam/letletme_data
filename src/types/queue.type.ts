import { Job, Queue, Worker } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { Redis } from 'ioredis';
import { QueueError } from './errors.type';

// Base Job Data
export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: unknown;
}

// Job Status
export type JobStatus = 'completed' | 'failed' | 'delayed' | 'active' | 'waiting' | 'paused';

// Job Operation Types
export type JobOperation = 'SYNC' | 'UPDATE' | 'CLEANUP';

// Job Types
export type JobType = 'META' | 'LIVE' | 'DAILY';

// Meta Job Types
export type MetaJobType = 'EVENTS' | 'PHASES' | 'TEAMS';

// Queue Adapter Types
export interface QueueAdapter<T extends BaseJobData> {
  readonly queue: Queue;
  readonly addJob: (data: T) => TE.TaskEither<QueueError, Job<T>>;
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
}

// Worker Adapter Types
export interface WorkerAdapter {
  readonly worker: Worker;
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
}

// Multi-Worker Adapter Types
export interface MultiWorkerAdapter {
  readonly workers: Worker[];
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
}

// Sequential Queue Adapter Types
export interface SequentialQueueAdapter<T extends BaseJobData> {
  readonly queues: Record<string, Queue>;
  readonly addJob: (queueName: string, data: T) => TE.TaskEither<QueueError, Job<T>>;
  readonly removeJob: (queueName: string, jobId: string) => TE.TaskEither<QueueError, void>;
}

// Job Processor Type
export type JobProcessor<T extends BaseJobData> = (job: Job<T>) => TE.TaskEither<QueueError, void>;

// Queue Connection Type
export type QueueConnection =
  | Redis
  | {
      host: string;
      port: number;
    };
