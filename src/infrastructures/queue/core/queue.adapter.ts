import { Queue } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueCleanupOptions, createQueueConfig } from '../../../configs/queue/queue.config';
import { createStandardQueueError } from '../../../queues/utils';
import { QueueError, QueueErrorCode, QueueOperation } from '../../../types/errors.type';
import { QueueAdapter } from '../types';

/**
 * Creates a queue adapter with the given configuration
 */
export const createQueueAdapter = (queueName: string): TE.TaskEither<QueueError, QueueAdapter> =>
  pipe(
    TE.tryCatch(
      async () => {
        const config = createQueueConfig(queueName);
        const queue = new Queue(config.name, {
          connection: config.connection,
          prefix: config.prefix,
        });

        return {
          queue,
          addJob: (data) =>
            TE.tryCatch(
              async () => queue.add(data.type, data),
              (error) =>
                createStandardQueueError({
                  code: QueueErrorCode.PROCESSING_ERROR,
                  message: 'Failed to add job',
                  queueName: config.name,
                  operation: QueueOperation.ADD_JOB,
                  cause: error as Error,
                }),
            ),
          removeJob: (jobId) =>
            TE.tryCatch(
              async () => {
                const job = await queue.getJob(jobId);
                if (job) {
                  await job.remove();
                }
              },
              (error) =>
                createStandardQueueError({
                  code: QueueErrorCode.PROCESSING_ERROR,
                  message: 'Failed to remove job',
                  queueName: config.name,
                  operation: QueueOperation.REMOVE_JOB,
                  cause: error as Error,
                }),
            ),
          pauseQueue: () =>
            TE.tryCatch(
              async () => queue.pause(),
              (error) =>
                createStandardQueueError({
                  code: QueueErrorCode.PROCESSING_ERROR,
                  message: 'Failed to pause queue',
                  queueName: config.name,
                  operation: QueueOperation.PAUSE_QUEUE,
                  cause: error as Error,
                }),
            ),
          resumeQueue: () =>
            TE.tryCatch(
              async () => queue.resume(),
              (error) =>
                createStandardQueueError({
                  code: QueueErrorCode.PROCESSING_ERROR,
                  message: 'Failed to resume queue',
                  queueName: config.name,
                  operation: QueueOperation.RESUME_QUEUE,
                  cause: error as Error,
                }),
            ),
          cleanQueue: (options?: QueueCleanupOptions) =>
            TE.tryCatch(
              async () => {
                const { age = 24 * 60 * 60 * 1000, limit = 1000 } = options || {};
                await queue.clean(age, limit);
              },
              (error) =>
                createStandardQueueError({
                  code: QueueErrorCode.PROCESSING_ERROR,
                  message: 'Failed to clean queue',
                  queueName: config.name,
                  operation: QueueOperation.CLEAN_QUEUE,
                  cause: error as Error,
                }),
            ),
        };
      },
      (error) =>
        createStandardQueueError({
          code: QueueErrorCode.CONNECTION_ERROR,
          message: 'Failed to create queue',
          queueName,
          operation: QueueOperation.CREATE_QUEUE,
          cause: error as Error,
        }),
    ),
  );
