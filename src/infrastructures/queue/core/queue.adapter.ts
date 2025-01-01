import { Queue, QueueOptions } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import { BaseJobData, QueueAdapter } from '../types';

const createQueueOptions = (): QueueOptions => ({
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 1000, 3000),
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
