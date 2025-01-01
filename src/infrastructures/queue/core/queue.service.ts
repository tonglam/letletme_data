import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../configs/queue/queue.config';
import { QueueError } from '../../../types/errors.type';
import { BaseJobData, JobProcessor } from '../../../types/queue.type';
import {
  createQueueAdapter,
  createScalableQueueAdapter,
  createSequentialQueueAdapter,
} from './queue.adapter';
import {
  createScalableWorkerAdapter,
  createSequentialWorkerAdapter,
  createWorkerAdapter,
} from './worker.adapter';

// Basic Queue Service (1:1)
export interface QueueService<T extends BaseJobData> {
  readonly addJob: (data: T) => TE.TaskEither<QueueError, void>;
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
}

// Scalable Queue Service (1:N)
export interface ScalableQueueService<T extends BaseJobData>
  extends Omit<QueueService<T>, 'startWorker' | 'stopWorker'> {
  readonly startWorkers: () => TE.TaskEither<QueueError, void>;
  readonly stopWorkers: () => TE.TaskEither<QueueError, void>;
}

// Sequential Queue Service (N:1)
export interface SequentialQueueService<T extends BaseJobData> {
  readonly addJob: (queueName: string, data: T) => TE.TaskEither<QueueError, void>;
  readonly removeJob: (queueName: string, jobId: string) => TE.TaskEither<QueueError, void>;
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
}

// Create basic queue service (1:1)
export const createQueueService = <T extends BaseJobData>(
  config: QueueConfig,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, QueueService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queue', () => createQueueAdapter<T>(config.name)),
    TE.bind('worker', () => createWorkerAdapter(config.name, config.connection, processor)),
    TE.map(({ queue, worker }) => ({
      addJob: (data: T) =>
        pipe(
          queue.addJob(data),
          TE.map(() => undefined),
        ),
      removeJob: (jobId: string) => queue.removeJob(jobId),
      startWorker: () => worker.start(),
      stopWorker: () => worker.stop(),
    })),
  );

// Create scalable queue service (1:N)
export const createScalableQueueService = <T extends BaseJobData>(
  config: QueueConfig,
  processor: JobProcessor<T>,
  options: {
    numWorkers: number;
    concurrency: number;
  },
): TE.TaskEither<QueueError, ScalableQueueService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queue', () => createScalableQueueAdapter<T>(config.name)),
    TE.bind('workers', () =>
      createScalableWorkerAdapter(config.name, config.connection, processor, options),
    ),
    TE.map(({ queue, workers }) => ({
      addJob: (data: T) =>
        pipe(
          queue.addJob(data),
          TE.map(() => undefined),
        ),
      removeJob: (jobId: string) => queue.removeJob(jobId),
      startWorkers: () => workers.start(),
      stopWorkers: () => workers.stop(),
    })),
  );

// Create sequential queue service (N:1)
export const createSequentialQueueService = <T extends BaseJobData>(
  config: QueueConfig,
  queueNames: string[],
  processor: JobProcessor<T>,
  options?: {
    priorities?: Record<string, number>;
  },
): TE.TaskEither<QueueError, SequentialQueueService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queues', () => createSequentialQueueAdapter<T>(queueNames, options)),
    TE.bind('worker', () =>
      createSequentialWorkerAdapter(queueNames, config.connection, processor),
    ),
    TE.map(({ queues, worker }) => ({
      addJob: (queueName: string, data: T) =>
        pipe(
          queues[queueName]?.addJob(data) ??
            TE.left({
              type: 'QUEUE_ERROR',
              code: 'QUEUE_NOT_FOUND',
              message: `Queue ${queueName} not found`,
              queueName,
            }),
          TE.map(() => undefined),
        ),
      removeJob: (queueName: string, jobId: string) =>
        pipe(
          queues[queueName]?.removeJob(jobId) ??
            TE.left({
              type: 'QUEUE_ERROR',
              code: 'QUEUE_NOT_FOUND',
              message: `Queue ${queueName} not found`,
              queueName,
            }),
        ),
      startWorker: () => worker.start(),
      stopWorker: () => worker.stop(),
    })),
  );
