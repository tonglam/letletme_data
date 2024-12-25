import { Job, Worker } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DEFAULT_QUEUE_OPTIONS } from '../config/queue.config';
import { BaseJobData, QueueOptions } from '../types';
import { createQueueProcessingError } from './errors';

/**
 * Worker adapter dependencies
 */
export interface WorkerDependencies<T extends BaseJobData> {
  readonly process: (job: Job<T>) => TE.TaskEither<Error, void>;
  readonly onCompleted?: (job: Job<T>) => void;
  readonly onFailed?: (job: Job<T>, error: Error) => void;
  readonly onError?: (error: Error) => void;
}

/**
 * Worker adapter interface
 */
export interface WorkerAdapter {
  readonly start: () => TE.TaskEither<Error, void>;
  readonly stop: () => TE.TaskEither<Error, void>;
}

/**
 * Creates a worker adapter
 */
export const createWorkerAdapter = <T extends BaseJobData>(
  options: QueueOptions,
  deps: WorkerDependencies<T>,
): WorkerAdapter => {
  let worker: Worker | undefined;

  const createWorker = () => {
    if (!worker) {
      worker = new Worker(
        options.name,
        async (job: Job) => {
          const result = await deps.process(job as Job<T>)();
          if (result._tag === 'Left') {
            throw result.left;
          }
        },
        {
          ...DEFAULT_QUEUE_OPTIONS,
          ...options,
        },
      );

      // Set up event handlers
      worker.on('completed', (job) => deps.onCompleted?.(job as Job<T>));
      worker.on('failed', (job, error) => deps.onFailed?.(job as Job<T>, error));
      worker.on('error', (error) => deps.onError?.(error));
    }
    return worker;
  };

  return {
    start: () =>
      pipe(
        TE.tryCatch(
          () => {
            createWorker();
            return Promise.resolve();
          },
          (error) =>
            createQueueProcessingError({
              message: `Failed to start worker for queue ${options.name}`,
              cause: error as Error,
            }),
        ),
      ),

    stop: () =>
      pipe(
        TE.tryCatch(
          async () => {
            if (worker) {
              await worker.close();
              worker = undefined;
            }
          },
          (error) =>
            createQueueProcessingError({
              message: `Failed to stop worker for queue ${options.name}`,
              cause: error as Error,
            }),
        ),
      ),
  };
};
