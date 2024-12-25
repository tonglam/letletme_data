import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { QueueService, createQueueService } from '../../../services/queue/queue.service';
import { META_QUEUE_CONFIG } from '../config/queue.config';
import {
  QUEUE_ATTEMPTS,
  QUEUE_JOB_STATES,
  QUEUE_JOB_TYPES,
  QUEUE_PRIORITIES,
} from '../core/constants';
import { createQueueProcessingError } from '../core/errors';
import { createQueueAdapter, createQueueDependencies } from '../core/queue.adapter';
import { MetaJobData } from '../types';

/**
 * Meta queue service interface
 */
export interface MetaQueueService extends QueueService<MetaJobData> {
  readonly addBootstrapJob: (
    data: Omit<MetaJobData, 'type' | 'timestamp'>,
  ) => TE.TaskEither<Error, Job<MetaJobData>>;
  readonly addPhasesJob: (
    data: Omit<MetaJobData, 'type' | 'timestamp'>,
  ) => TE.TaskEither<Error, Job<MetaJobData>>;
  readonly addEventsJob: (
    data: Omit<MetaJobData, 'type' | 'timestamp'>,
  ) => TE.TaskEither<Error, Job<MetaJobData>>;
  readonly getPendingJobs: () => TE.TaskEither<Error, Job<MetaJobData>[]>;
  readonly getFailedJobs: () => TE.TaskEither<Error, Job<MetaJobData>[]>;
  readonly getCompletedJobs: () => TE.TaskEither<Error, Job<MetaJobData>[]>;
  readonly removeJob: (jobId: string) => TE.TaskEither<Error, void>;
  readonly retryJob: (jobId: string) => TE.TaskEither<Error, void>;
}

/**
 * Creates a meta queue service
 */
export const createMetaQueueService = (): MetaQueueService => {
  const deps = createQueueDependencies(META_QUEUE_CONFIG);
  const adapter = createQueueAdapter<MetaJobData>(deps);
  const queueService = createQueueService<MetaJobData>(adapter);

  return {
    ...queueService,

    addBootstrapJob: (data) =>
      queueService.add(
        {
          type: QUEUE_JOB_TYPES.BOOTSTRAP,
          timestamp: new Date(),
          ...data,
        },
        {
          priority: QUEUE_PRIORITIES.HIGH,
          attempts: QUEUE_ATTEMPTS.BOOTSTRAP,
        },
      ),

    addPhasesJob: (data) =>
      queueService.add(
        {
          type: QUEUE_JOB_TYPES.PHASES,
          timestamp: new Date(),
          ...data,
        },
        {
          priority: QUEUE_PRIORITIES.MEDIUM,
          attempts: QUEUE_ATTEMPTS.DEFAULT,
        },
      ),

    addEventsJob: (data) =>
      queueService.add(
        {
          type: QUEUE_JOB_TYPES.EVENTS,
          timestamp: new Date(),
          ...data,
        },
        {
          priority: QUEUE_PRIORITIES.MEDIUM,
          attempts: QUEUE_ATTEMPTS.DEFAULT,
        },
      ),

    getPendingJobs: () =>
      pipe(
        TE.tryCatch(
          () => deps.queue.getJobs(QUEUE_JOB_STATES.PENDING) as Promise<Job<MetaJobData>[]>,
          (error) =>
            createQueueProcessingError({
              message: 'Failed to get pending jobs',
              cause: error as Error,
            }),
        ),
      ),

    getFailedJobs: () =>
      pipe(
        TE.tryCatch(
          () => deps.queue.getJobs(QUEUE_JOB_STATES.FAILED) as Promise<Job<MetaJobData>[]>,
          (error) =>
            createQueueProcessingError({
              message: 'Failed to get failed jobs',
              cause: error as Error,
            }),
        ),
      ),

    getCompletedJobs: () =>
      pipe(
        TE.tryCatch(
          () => deps.queue.getJobs(QUEUE_JOB_STATES.COMPLETED) as Promise<Job<MetaJobData>[]>,
          (error) =>
            createQueueProcessingError({
              message: 'Failed to get completed jobs',
              cause: error as Error,
            }),
        ),
      ),

    removeJob: (jobId: string) =>
      pipe(
        queueService.getJob(jobId),
        TE.chain((job) =>
          job
            ? pipe(
                TE.tryCatch(
                  () => job.remove(),
                  (error) =>
                    createQueueProcessingError({
                      message: `Failed to remove job ${jobId}`,
                      job: job as Job<MetaJobData>,
                      cause: error as Error,
                    }),
                ),
              )
            : TE.right(undefined),
        ),
      ),

    retryJob: (jobId: string) =>
      pipe(
        queueService.getJob(jobId),
        TE.chain((job) =>
          job
            ? pipe(
                TE.tryCatch(
                  () => job.retry(),
                  (error) =>
                    createQueueProcessingError({
                      message: `Failed to retry job ${jobId}`,
                      job: job as Job<MetaJobData>,
                      cause: error as Error,
                    }),
                ),
              )
            : TE.right(undefined),
        ),
      ),
  };
};
