import { Worker } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueConfig } from '../../../configs/queue/queue.config';
import { createStandardQueueError } from '../../../queues/utils';
import { QueueError, QueueErrorCode, QueueOperation } from '../../../types/errors.type';
import { BaseJobData, JobProcessor, WorkerAdapter } from '../types';

/**
 * Creates a worker adapter with the given configuration and processor
 */
export const createWorkerAdapter = <T extends BaseJobData>(
  queueName: string,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, WorkerAdapter<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const config = createQueueConfig(queueName);
        const worker = new Worker<T>(
          config.name,
          async (job) =>
            pipe(await processor(job)(), (result) => {
              if (result._tag === 'Left') {
                throw result.left;
              }
            }),
          {
            connection: config.connection,
            prefix: config.prefix,
          },
        );

        return {
          worker,
          start: () =>
            TE.tryCatch(
              async () => worker.resume(),
              (error) =>
                createStandardQueueError({
                  code: QueueErrorCode.PROCESSING_ERROR,
                  message: 'Failed to start worker',
                  queueName: config.name,
                  operation: QueueOperation.START_WORKER,
                  cause: error as Error,
                }),
            ),
          stop: () =>
            TE.tryCatch(
              async () => worker.pause(),
              (error) =>
                createStandardQueueError({
                  code: QueueErrorCode.PROCESSING_ERROR,
                  message: 'Failed to stop worker',
                  queueName: config.name,
                  operation: QueueOperation.STOP_WORKER,
                  cause: error as Error,
                }),
            ),
          isRunning: () => !worker.isPaused(),
        };
      },
      (error) =>
        createStandardQueueError({
          code: QueueErrorCode.CONNECTION_ERROR,
          message: 'Failed to create worker',
          queueName,
          operation: QueueOperation.CREATE_WORKER,
          cause: error as Error,
        }),
    ),
  );
