import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getSharedLogger } from '../../../../infrastructure/api/common/logs';
import {
  META_QUEUE_CONFIG,
  MetaJobData,
  QUEUE_ATTEMPTS,
  QUEUE_JOB_STATES,
  QUEUE_JOB_TYPES,
  QUEUE_PRIORITIES,
  createMonitorService,
  createQueueAdapter,
  createQueueDependencies,
} from '../../../../infrastructure/queue';
import { QueueService, createQueueService } from '../../queue.service';

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
  readonly addTeamsJob: (
    data: Omit<MetaJobData, 'type' | 'timestamp'>,
  ) => TE.TaskEither<Error, Job<MetaJobData>>;
  readonly getPendingJobs: () => TE.TaskEither<Error, Job<MetaJobData>[]>;
  readonly getFailedJobs: () => TE.TaskEither<Error, Job<MetaJobData>[]>;
  readonly getCompletedJobs: () => TE.TaskEither<Error, Job<MetaJobData>[]>;
  readonly removeJob: (jobId: string) => TE.TaskEither<Error, void>;
  readonly retryJob: (jobId: string) => TE.TaskEither<Error, void>;
}

/**
 * Creates a meta queue service with monitoring
 */
export const createMetaQueueService = (): MetaQueueService => {
  const deps = createQueueDependencies(META_QUEUE_CONFIG);
  const adapter = createQueueAdapter<MetaJobData>(deps);
  const queueService = createQueueService<MetaJobData>(adapter);
  const logger = getSharedLogger({
    name: 'meta-queue',
    level: process.env.LOG_LEVEL || 'info',
    filepath: './logs',
  });

  // Initialize queue monitor
  const monitor = createMonitorService({
    queue: deps.queue,
    events: deps.events,
    logger,
    config: {
      metricsInterval: 60000, // 1 minute
      historySize: 1440, // 24 hours
    },
  });

  // Start monitoring
  pipe(
    monitor.start(),
    TE.mapLeft((error) =>
      logger.error({ error, queueName: deps.queue.name }, 'Failed to start queue monitoring'),
    ),
  )();

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

    addTeamsJob: (data) =>
      queueService.add(
        {
          type: QUEUE_JOB_TYPES.TEAMS,
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
          () => deps.queue.getJobs(QUEUE_JOB_STATES.PENDING),
          (error) => new Error(`Failed to get pending jobs: ${(error as Error).message}`),
        ),
      ),

    getFailedJobs: () =>
      pipe(
        TE.tryCatch(
          () => deps.queue.getJobs(QUEUE_JOB_STATES.FAILED),
          (error) => new Error(`Failed to get failed jobs: ${(error as Error).message}`),
        ),
      ),

    getCompletedJobs: () =>
      pipe(
        TE.tryCatch(
          () => deps.queue.getJobs(QUEUE_JOB_STATES.COMPLETED),
          (error) => new Error(`Failed to get completed jobs: ${(error as Error).message}`),
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
                    new Error(`Failed to remove job ${jobId}: ${(error as Error).message}`),
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
                  (error) => new Error(`Failed to retry job ${jobId}: ${(error as Error).message}`),
                ),
              )
            : TE.right(undefined),
        ),
      ),
  };
};
