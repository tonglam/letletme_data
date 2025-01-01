import { Queue, QueueOptions } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import { DEFAULT_OPTIONS } from '../../redis/client';
import { BaseJobData, QueueAdapter } from '../types';

const createQueueOptions = (): QueueOptions => ({
  connection: {
    ...DEFAULT_OPTIONS,
    maxRetriesPerRequest: null,
  },
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});

export const createQueueAdapter = <T extends BaseJobData>(
  name: string,
): TE.TaskEither<QueueError, QueueAdapter<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const queue = new Queue(name, createQueueOptions());

        return {
          queue,
          addJob: (data: T) =>
            TE.tryCatch(
              () => queue.add(data.type, data),
              (error) => createQueueError(QueueErrorCode.ADD_JOB, queue.name, error as Error),
            ),
          removeJob: (jobId: string) =>
            TE.tryCatch(
              async () => {
                const job = await queue.getJob(jobId);
                if (job) {
                  await job.remove();
                }
              },
              (error) => createQueueError(QueueErrorCode.REMOVE_JOB, queue.name, error as Error),
            ),
        };
      },
      (error) => createQueueError(QueueErrorCode.CREATE_QUEUE, name, error as Error),
    ),
  );
