import { Job, JobsOptions, Queue, QueueEvents } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DEFAULT_QUEUE_OPTIONS } from '../config/queue.config';
import { BaseJobData, QueueDependencies, QueueOptions } from '../types';
import { createQueueConnectionError, createQueueProcessingError } from './errors';

/**
 * Job counts type
 */
export interface JobCounts {
  readonly waiting: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly delayed: number;
  readonly paused: number;
}

/**
 * Queue adapter for BullMQ operations
 */
export interface QueueAdapter<T extends BaseJobData> {
  readonly add: (data: T, opts?: JobsOptions) => TE.TaskEither<Error, Job<T>>;
  readonly addBulk: (
    jobs: ReadonlyArray<{ readonly data: T; readonly opts?: JobsOptions }>,
  ) => TE.TaskEither<Error, ReadonlyArray<Job<T>>>;
  readonly pause: () => TE.TaskEither<Error, void>;
  readonly resume: () => TE.TaskEither<Error, void>;
  readonly clean: (grace: number, limit: number) => TE.TaskEither<Error, number>;
  readonly close: () => TE.TaskEither<Error, void>;
  readonly getJob: (jobId: string) => TE.TaskEither<Error, Job<T> | null>;
  readonly getJobCounts: () => TE.TaskEither<Error, JobCounts>;
}

/**
 * Creates queue dependencies
 */
export const createQueueDependencies = (options: QueueOptions): QueueDependencies => ({
  queue: new Queue(options.name, {
    ...DEFAULT_QUEUE_OPTIONS,
    ...options,
  }),
  events: new QueueEvents(options.name, {
    ...DEFAULT_QUEUE_OPTIONS,
    ...options,
  }),
});

/**
 * Creates a queue adapter
 */
export const createQueueAdapter = <T extends BaseJobData>(
  deps: QueueDependencies,
): QueueAdapter<T> => {
  const handleError = (message: string, error: unknown): Error =>
    createQueueProcessingError({
      message: `${message} ${deps.queue.name}`,
      cause: error as Error,
    });

  return {
    add: (data: T, opts?: JobsOptions) =>
      pipe(
        TE.tryCatch(
          () => deps.queue.add(data.type, data, opts),
          (error) => handleError('Failed to add job to queue', error),
        ),
      ),

    addBulk: (jobs) =>
      pipe(
        TE.tryCatch(
          () =>
            deps.queue.addBulk(
              jobs.map((job) => ({
                name: job.data.type,
                data: job.data,
                opts: job.opts,
              })),
            ),
          (error) => handleError('Failed to add bulk jobs to queue', error),
        ),
      ),

    pause: () =>
      pipe(
        TE.tryCatch(
          () => deps.queue.pause(),
          (error) => handleError('Failed to pause queue', error),
        ),
      ),

    resume: () =>
      pipe(
        TE.tryCatch(
          () => deps.queue.resume(),
          (error) => handleError('Failed to resume queue', error),
        ),
      ),

    clean: (grace: number, limit: number) =>
      pipe(
        TE.tryCatch(
          async () => {
            const cleaned = await deps.queue.clean(grace, limit);
            return cleaned.length;
          },
          (error) => handleError('Failed to clean queue', error),
        ),
      ),

    close: () =>
      pipe(
        TE.tryCatch(
          async () => {
            await deps.queue.close();
            await deps.events.close();
          },
          (error) =>
            createQueueConnectionError({
              message: `Failed to close queue ${deps.queue.name}`,
              cause: error as Error,
            }),
        ),
      ),

    getJob: (jobId: string) =>
      pipe(
        TE.tryCatch(
          () => deps.queue.getJob(jobId),
          (error) => handleError(`Failed to get job ${jobId} from queue`, error),
        ),
      ),

    getJobCounts: () =>
      pipe(
        TE.tryCatch(
          async () => {
            const counts = await deps.queue.getJobCounts();
            return {
              waiting: counts.waiting ?? 0,
              active: counts.active ?? 0,
              completed: counts.completed ?? 0,
              failed: counts.failed ?? 0,
              delayed: counts.delayed ?? 0,
              paused: counts.paused ?? 0,
            };
          },
          (error) => handleError('Failed to get job counts for queue', error),
        ),
      ),
  };
};
