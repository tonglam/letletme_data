import { Job, Queue, QueueOptions } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as RTE from 'fp-ts/ReaderTaskEither';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../configs/queue/queue.config';
import { createStandardQueueError } from '../../queues/utils';
import { QueueError, QueueErrorCode } from '../../types/errors.type';
import { BaseJobData, QueueOperation, WorkerAdapter, WorkerEnv } from '../../types/queue.type';
import { logQueueJob } from '../../utils/logger.util';

/**
 * Executes an operation on all workers in the registry
 */
export const executeOnAll = (
  operation: (adapter: WorkerAdapter<BaseJobData>) => TE.TaskEither<QueueError, void>,
  opType: QueueOperation,
): RTE.ReaderTaskEither<WorkerEnv, QueueError, void> =>
  pipe(
    RTE.ask<WorkerEnv>(),
    RTE.chainTaskEitherK((env) =>
      pipe(
        TE.sequenceArray(
          Object.values(env.registry).map((adapter) =>
            operation(adapter as WorkerAdapter<BaseJobData>),
          ),
        ),
        TE.mapLeft((error) =>
          createStandardQueueError({
            code: QueueErrorCode.PROCESSING_ERROR,
            message: 'Failed to execute operation on all workers',
            queueName: 'all',
            operation: opType,
            cause: error,
          }),
        ),
        TE.map(() => undefined),
      ),
    ),
  );

/**
 * Creates a repeatable job schedule
 */
export const createSchedule = <T extends BaseJobData>(
  config: QueueConfig,
  schedule: string,
  jobData: T,
  options: {
    priority?: number;
    attempts?: number;
  } = {},
): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        const queueOptions: QueueOptions = {
          connection: config.connection,
          prefix: config.prefix,
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: 1000,
            ...options,
          },
        };

        const queue = new Queue(jobData.type, queueOptions);

        await queue.add(jobData.type, jobData, {
          repeat: {
            pattern: schedule,
          },
          ...options,
        });

        logQueueJob('Schedule created', {
          queueName: jobData.type,
          jobId: 'schedule',
        });
      },
      (error): QueueError =>
        createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: 'Failed to create schedule',
          queueName: jobData.type,
          operation: QueueOperation.CREATE_SCHEDULE,
          cause: error as Error,
        }),
    ),
  );

/**
 * Cleans up completed and failed jobs
 */
export const cleanupJobs = (
  queue: Queue,
  options: {
    age?: number; // in milliseconds
    limit?: number;
  } = {},
): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        const { age = 24 * 60 * 60 * 1000, limit = 1000 } = options;
        await queue.clean(age, limit);
        logQueueJob('Jobs cleaned up', {
          queueName: queue.name,
          jobId: 'system',
        });
      },
      (error): QueueError =>
        createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: 'Failed to cleanup jobs',
          queueName: queue.name,
          operation: QueueOperation.CLEANUP_JOBS,
          cause: error as Error,
        }),
    ),
  );

/**
 * Gets job status and details
 */
export const getJobStatus = (queue: Queue, jobId: string): TE.TaskEither<QueueError, Job | null> =>
  pipe(
    TE.tryCatch(
      async () => {
        const job = await queue.getJob(jobId);
        if (job) {
          logQueueJob('Job status retrieved', {
            queueName: queue.name,
            jobId,
          });
        }
        return job;
      },
      (error): QueueError =>
        createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: 'Failed to get job status',
          queueName: queue.name,
          operation: QueueOperation.GET_JOB_STATUS,
          cause: error as Error,
        }),
    ),
  );

/**
 * Gets queue metrics
 */
export const getQueueMetrics = (
  queue: Queue,
): TE.TaskEither<
  QueueError,
  {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }
> =>
  pipe(
    TE.tryCatch(
      async () => {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount(),
        ]);

        logQueueJob('Queue metrics retrieved', {
          queueName: queue.name,
          jobId: 'system',
        });

        return {
          waiting,
          active,
          completed,
          failed,
          delayed,
        };
      },
      (error): QueueError =>
        createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: 'Failed to get queue metrics',
          queueName: queue.name,
          operation: QueueOperation.GET_QUEUE_METRICS,
          cause: error as Error,
        }),
    ),
  );
