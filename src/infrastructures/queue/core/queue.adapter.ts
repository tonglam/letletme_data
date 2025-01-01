import { Queue, QueueOptions } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QUEUE_CONSTANTS } from '../../../configs/queue/queue.config';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import { BaseJobData, QueueAdapter } from '../../../types/queue.type';
import { DEFAULT_OPTIONS } from '../../redis/client';

// Create queue options with defaults from config
const createQueueOptions = (options?: {
  priority?: number;
  attempts?: number;
  backoff?: typeof QUEUE_CONSTANTS.BACKOFF;
}): QueueOptions => ({
  connection: {
    ...DEFAULT_OPTIONS,
    maxRetriesPerRequest: null,
  },
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: options?.attempts ?? QUEUE_CONSTANTS.ATTEMPTS.MEDIUM,
    backoff: options?.backoff
      ? {
          type: QUEUE_CONSTANTS.BACKOFF.TYPE,
          delay: QUEUE_CONSTANTS.BACKOFF.DELAY,
        }
      : undefined,
    priority: options?.priority,
  },
});

// Basic Queue Adapter (1:1 Pattern)
export const createQueueAdapter = <T extends BaseJobData>(
  name: string,
  options?: QueueOptions,
): TE.TaskEither<QueueError, QueueAdapter<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const queue = new Queue(name, options ?? createQueueOptions());

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

// Scalable Queue Adapter (1:N Pattern)
export const createScalableQueueAdapter = <T extends BaseJobData>(
  name: string,
  options?: QueueOptions,
): TE.TaskEither<QueueError, QueueAdapter<T>> =>
  pipe(
    createQueueAdapter<T>(
      name,
      options ??
        createQueueOptions({
          attempts: QUEUE_CONSTANTS.ATTEMPTS.HIGH,
          backoff: QUEUE_CONSTANTS.BACKOFF,
        }),
    ),
  );

// Sequential Queue Adapter (N:1 Pattern)
export const createSequentialQueueAdapter = <T extends BaseJobData>(
  names: string[],
  options?: { priorities?: Record<string, number> },
): TE.TaskEither<QueueError, Record<string, QueueAdapter<T>>> =>
  pipe(
    names,
    TE.traverseArray((name) =>
      pipe(
        createQueueAdapter<T>(
          name,
          createQueueOptions({
            priority: options?.priorities?.[name],
            attempts: QUEUE_CONSTANTS.ATTEMPTS.MEDIUM,
          }),
        ),
        TE.map((adapter) => [name, adapter] as const),
      ),
    ),
    TE.map(Object.fromEntries),
  );
