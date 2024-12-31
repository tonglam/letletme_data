import { Queue } from 'bullmq';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { QueueCleanupOptions, createQueueConfig } from '../../../configs/queue/queue.config';
import { QueueError, QueueErrorCode } from '../../../types/errors.type';
import { BaseJobData, JobStatus, QueueAdapter } from '../../../types/queue.type';
import { QueueOperation } from '../../../types/shared.type';
import { createStandardQueueError } from '../../../utils/queue.utils';

const createQueueConnection = (host: string, port: number) => ({
  host,
  port,
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  connectTimeout: 5000,
});

const createQueueInstance = (name: string, prefix: string): Queue =>
  new Queue(name, {
    connection: createQueueConnection(
      process.env.REDIS_HOST || 'localhost',
      parseInt(process.env.REDIS_PORT || '6379', 10),
    ),
    prefix,
  });

const handleJobRemoval = (queue: Queue, jobId: string) =>
  pipe(
    TE.tryCatch(
      async () => {
        const job = await queue.getJob(jobId);
        return pipe(
          O.fromNullable(job),
          O.fold(
            () => Promise.resolve(undefined),
            async (j) => {
              const isCompleted = await j.isCompleted();
              const isFailed = await j.isFailed();
              const isActive = await j.isActive();
              const isWaiting = await j.isWaiting();

              if (isCompleted || isFailed) {
                await j.remove();
                return;
              }

              if (isActive || isWaiting) {
                await j.discard();
                await j.remove();
                return;
              }

              await j.remove();

              // Verify removal with retries
              const verifyRemoval = async (attempts: number): Promise<void> => {
                if (attempts >= 10) {
                  throw new Error(`Failed to remove job ${jobId}: Timeout`);
                }
                const checkJob = await queue.getJob(jobId);
                if (!checkJob) return;
                await new Promise((resolve) => setTimeout(resolve, 100));
                return verifyRemoval(attempts + 1);
              };

              return verifyRemoval(0);
            },
          ),
        );
      },
      (error) =>
        createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: `Failed to remove job ${jobId}`,
          queueName: queue.name,
          operation: QueueOperation.REMOVE_JOB,
          cause: error as Error,
        }),
    ),
  );

const handleQueueCleanup = (queue: Queue, options?: QueueCleanupOptions) =>
  pipe(
    TE.tryCatch(
      async () => {
        const defaultStatuses: Array<JobStatus> = [
          JobStatus.COMPLETED,
          JobStatus.FAILED,
          JobStatus.DELAYED,
          JobStatus.ACTIVE,
          JobStatus.WAITING,
          JobStatus.PAUSED,
        ];
        const statuses = options?.status ? [options.status] : defaultStatuses;

        const cleanStatus = async (status: JobStatus) =>
          queue.clean(options?.age || 0, options?.limit || 1000, status);

        await pipe(statuses, A.map(cleanStatus), (promises) => Promise.all(promises));

        const verifyCleanup = async (attempts: number): Promise<void> => {
          if (attempts >= 20) {
            const remainingJobs = await queue.getJobs();
            if (remainingJobs.length > 0) {
              await pipe(
                remainingJobs,
                A.map((job) => job.remove().catch(console.error)),
                (promises) => Promise.all(promises),
              );

              const finalJobs = await queue.getJobs();
              if (finalJobs.length > 0) {
                throw new Error(
                  `Failed to clean all jobs: ${finalJobs.length} jobs remaining after ${attempts} attempts`,
                );
              }
            }
            return;
          }

          const remainingJobs = await queue.getJobs();
          if (remainingJobs.length === 0) return;

          if (options?.status) {
            const remainingStatusJobs = await queue.getJobs([options.status]);
            if (remainingStatusJobs.length === 0) return;
          }

          await new Promise((resolve) => setTimeout(resolve, 500));
          return verifyCleanup(attempts + 1);
        };

        return verifyCleanup(0);
      },
      (error) =>
        createStandardQueueError({
          code: QueueErrorCode.PROCESSING_ERROR,
          message: 'Failed to clean queue',
          queueName: queue.name,
          operation: QueueOperation.CLEAN_QUEUE,
          cause: error as Error,
        }),
    ),
  );

/**
 * Creates a queue adapter with the given configuration
 */
export const createQueueAdapter = (queueName: string): TE.TaskEither<QueueError, QueueAdapter> =>
  pipe(
    TE.tryCatch(
      async () => {
        const config = createQueueConfig(queueName);
        const queue = createQueueInstance(config.name, config.prefix);

        return {
          queue,
          addJob: <T extends BaseJobData>(data: T) =>
            TE.tryCatch(
              async () => queue.add(data.type, data),
              (error) =>
                createStandardQueueError({
                  code: QueueErrorCode.PROCESSING_ERROR,
                  message: 'Failed to add job',
                  queueName: queue.name,
                  operation: QueueOperation.ADD_JOB,
                  cause: error as Error,
                }),
            ),
          removeJob: (jobId: string) => handleJobRemoval(queue, jobId),
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
          cleanQueue: (options?: QueueCleanupOptions) => handleQueueCleanup(queue, options),
        };
      },
      (error) =>
        createStandardQueueError({
          code: QueueErrorCode.CONNECTION_ERROR,
          message: 'Failed to create queue',
          queueName,
          operation: QueueOperation.CREATE_WORKER,
          cause: error as Error,
        }),
    ),
  );
