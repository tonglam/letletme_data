import { Job, JobsOptions } from 'bullmq';
import { CronJob } from 'cron';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import {
  JobDefinition,
  JobOptions,
  JobServiceState,
  JobStatus,
  Queue,
  QueueName,
  SchedulerState,
} from '../../types/jobs.type';

// Validation utilities
export const validateWithSchema =
  <T>(schema: z.ZodType<T>) =>
  (data: unknown): E.Either<Error, T> =>
    pipe(
      E.tryCatch(
        () => schema.parse(data),
        (error) => new Error(`Validation failed: ${error}`),
      ),
    );

// Job operation utilities
export const withJobDefinition = <T>(
  state: JobServiceState,
  jobName: string,
  operation: (definition: JobDefinition) => TE.TaskEither<Error, T>,
): TE.TaskEither<Error, T> =>
  pipe(
    state.jobDefinitions[jobName],
    O.fromNullable,
    E.fromOption(() => new Error(`No job definition found for ${jobName}`)),
    TE.fromEither,
    TE.chain(operation),
  );

export const withQueue = <T>(
  state: JobServiceState,
  queueName: QueueName,
  operation: (queue: Queue) => TE.TaskEither<Error, T>,
): TE.TaskEither<Error, T> =>
  pipe(
    state.queues[queueName],
    O.fromNullable,
    E.fromOption(() => new Error(`No queue found for ${queueName}`)),
    TE.fromEither,
    TE.chain(operation),
  );

// Job processing utilities
export const processJobSafely = <TData, TResult>(
  job: Job<TData>,
  handler: (data: TData) => Promise<TResult>,
): TE.TaskEither<Error, TResult> =>
  pipe(
    TE.tryCatch(
      () => handler(job.data),
      (error) => new Error(`Job processing failed: ${error}`),
    ),
  );

// Job options utilities
export const mergeJobOptions = (
  defaultOptions: JobsOptions,
  overrides?: JobOptions,
): JobsOptions => ({
  ...defaultOptions,
  ...(overrides
    ? {
        priority: overrides.priority ? Number(overrides.priority) : defaultOptions.priority,
        attempts: overrides.attempts ?? defaultOptions.attempts,
        backoff: overrides.backoff ?? defaultOptions.backoff,
      }
    : {}),
});

// Scheduler utilities
export const withCronJob = <T>(
  state: SchedulerState,
  jobName: string,
  operation: (cronJob: CronJob) => E.Either<Error, T>,
): E.Either<Error, T> =>
  pipe(
    state.cronJobs[jobName],
    O.fromNullable,
    E.fromOption(() => new Error(`No cron job found for ${jobName}`)),
    E.chain(operation),
  );

// Batch operation utilities
export const processBatch = <T, R>(
  items: T[],
  processor: (item: T) => TE.TaskEither<Error, R>,
): TE.TaskEither<Error, Array<R>> =>
  pipe(items, TE.traverseArray(processor)) as TE.TaskEither<Error, Array<R>>;

// Error handling utilities
export const handleJobError =
  (context: string) =>
  (error: Error): E.Either<Error, never> =>
    E.left(new Error(`${context}: ${error.message}`));

// Job status utilities
export const getJobStatusSafe = (state: SchedulerState, jobName: string): O.Option<JobStatus> =>
  pipe(
    state.cronJobs[jobName],
    O.fromNullable,
    O.map((job) => ({
      registered: true,
      running: job.running,
      schedule: job.cronTime?.toString(),
    })),
  );

export const getJobStatuses = (
  state: SchedulerState,
  jobNames: string[],
): Record<string, O.Option<JobStatus>> =>
  pipe(
    jobNames,
    A.map((name) => [name, getJobStatusSafe(state, name)] as const),
    (entries) => Object.fromEntries(entries) as Record<string, O.Option<JobStatus>>,
  );

// Job lifecycle utilities
export const executeWithLifecycle = <TData, TResult>(
  jobDefinition: JobDefinition<TData, TResult>,
  data: TData,
): TE.TaskEither<Error, TResult> =>
  pipe(
    TE.tryCatch(
      async () => {
        try {
          const result = await jobDefinition.handler(data);
          if (E.isRight(result)) {
            await jobDefinition.onComplete?.(result.right);
            return result.right;
          }
          await jobDefinition.onFailed?.(result.left);
          throw result.left;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await jobDefinition.onFailed?.(err);
          throw err;
        }
      },
      (error) => (error instanceof Error ? error : new Error(String(error))),
    ),
  );

// Composition utilities
export const composeJobHandlers =
  <T, U, V>(
    f: (data: T) => TE.TaskEither<Error, U>,
    g: (data: U) => TE.TaskEither<Error, V>,
  ): ((data: T) => TE.TaskEither<Error, V>) =>
  (data) =>
    pipe(f(data), TE.chain(g));

// Retry utilities
export const withRetry = <T>(
  operation: TE.TaskEither<Error, T>,
  retries: number,
  delay: number,
): TE.TaskEither<Error, T> => {
  const retry = (attempts: number): TE.TaskEither<Error, T> =>
    pipe(
      operation,
      TE.orElse((error) =>
        attempts > 0
          ? pipe(
              TE.tryCatch(
                () => new Promise((resolve) => setTimeout(resolve, delay)),
                () => error,
              ),
              TE.chain(() => retry(attempts - 1)),
            )
          : TE.left(error),
      ),
    );
  return retry(retries);
};
