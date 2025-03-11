import { JobsOptions, Queue } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QUEUE_CONFIG } from '../../../config/queue/queue.config';
import { createQueueError, QueueError, QueueErrorCode } from '../../../types/error.type';
import { MetaJobData } from '../../../types/job.type';
import { getQueueLogger } from '../../logger';
import { BullMQJobStatus, JobOptions, QueueService } from '../types';
import { createSchedulerService } from './scheduler.service';

const logger = getQueueLogger();

const convertToJobOptions = (options?: JobOptions): JobsOptions => {
  if (!options) return {};

  return {
    priority: options.priority,
    lifo: options.lifo,
    delay: options.delay,
    repeat: options.repeat,
    jobId: options.jobId,
    timestamp: options.timestamp,
    attempts: options.attempts,
    backoff: options.backoff
      ? { type: options.backoff.type, delay: options.backoff.delay }
      : undefined,
  };
};

export const createQueueServiceImpl = <T extends MetaJobData>(
  name: string,
): TE.TaskEither<QueueError, QueueService<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        type QueueType = Queue<T>;
        const queue = new Queue<T>(name, {
          connection: {
            host: QUEUE_CONFIG.REDIS.HOST,
            port: QUEUE_CONFIG.REDIS.PORT,
            password: QUEUE_CONFIG.REDIS.PASSWORD,
          },
          defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
          prefix: 'test',
        }) as QueueType;

        logger.info({ name }, 'Queue service initialized');

        const scheduler = createSchedulerService<T>(name, queue);

        const validateJobData = (data: T): TE.TaskEither<QueueError, T> => {
          if (!data || typeof data !== 'object') {
            return TE.left(
              createQueueError(
                QueueErrorCode.INVALID_JOB_DATA,
                name,
                new Error('Job data must be a non-null object'),
              ),
            );
          }

          if (!('name' in data)) {
            return TE.left(
              createQueueError(
                QueueErrorCode.INVALID_JOB_DATA,
                name,
                new Error('Job data must contain a name'),
              ),
            );
          }

          if (!('type' in data)) {
            return TE.left(
              createQueueError(
                QueueErrorCode.INVALID_JOB_DATA,
                name,
                new Error('Job data must contain a type'),
              ),
            );
          }

          if (!('timestamp' in data)) {
            return TE.left(
              createQueueError(
                QueueErrorCode.INVALID_JOB_DATA,
                name,
                new Error('Job data must contain a timestamp'),
              ),
            );
          }

          if (!('data' in data)) {
            return TE.left(
              createQueueError(
                QueueErrorCode.INVALID_JOB_DATA,
                name,
                new Error('Job data must contain a data field'),
              ),
            );
          }

          return TE.right(data);
        };

        const close = (): TE.TaskEither<QueueError, void> =>
          pipe(
            TE.tryCatch(
              async () => {
                await queue.close();
                logger.info({ name }, 'Queue service closed');
              },
              (error) => createQueueError(QueueErrorCode.STOP_WORKER, name, error as Error),
            ),
          );

        const addJob = (data: T, options?: JobOptions): TE.TaskEither<QueueError, void> =>
          pipe(
            validateJobData(data),
            TE.chain(() =>
              TE.tryCatch(
                async () => {
                  // @ts-ignore - BullMQ v5 compatibility
                  await queue.add(data.name as any, data, convertToJobOptions(options));
                  logger.info(
                    { name, jobType: data.type, options },
                    options?.lifo ? 'Job added (LIFO)' : 'Job added (FIFO)',
                  );
                },
                (error) => createQueueError(QueueErrorCode.ADD_JOB, name, error as Error),
              ),
            ),
          );

        const addBulk = (
          jobs: Array<{ data: T; options?: JobOptions }>,
        ): TE.TaskEither<QueueError, void> =>
          pipe(
            TE.tryCatch(
              async () => {
                if (jobs.length === 0) return;

                const bulkJobs = jobs.map((job) => ({
                  name: job.data.name as any,
                  data: job.data,
                  opts: convertToJobOptions(job.options),
                }));

                // @ts-ignore - BullMQ v5 compatibility
                await queue.addBulk(bulkJobs);
                logger.info({ name, count: jobs.length }, 'Bulk jobs added');
              },
              (error) => createQueueError(QueueErrorCode.ADD_JOB, name, error as Error),
            ),
          );

        const removeJob = (jobId: string): TE.TaskEither<QueueError, void> =>
          pipe(
            TE.tryCatch(
              async () => {
                const job = await queue.getJob(jobId);
                if (job) {
                  await job.remove();
                  logger.info({ name, jobId }, 'Job removed');
                }
              },
              (error) => createQueueError(QueueErrorCode.REMOVE_JOB, name, error as Error),
            ),
          );

        const drain = (): TE.TaskEither<QueueError, void> =>
          pipe(
            TE.tryCatch(
              async () => {
                await queue.drain();
                logger.info({ name }, 'Queue drained (removed waiting and delayed jobs)');
              },
              (error) => createQueueError(QueueErrorCode.REMOVE_JOB, name, error as Error),
            ),
          );

        const clean = (
          gracePeriod: number,
          limit: number,
          status: BullMQJobStatus,
        ): TE.TaskEither<QueueError, string[]> =>
          pipe(
            TE.tryCatch(
              async () => {
                const removedJobs = await queue.clean(gracePeriod, limit, status);
                logger.info(
                  { name, gracePeriod, limit, status, count: removedJobs.length },
                  'Cleaned jobs with status',
                );
                return removedJobs;
              },
              (error) => createQueueError(QueueErrorCode.REMOVE_JOB, name, error as Error),
            ),
          );

        const obliterate = (): TE.TaskEither<QueueError, void> =>
          pipe(
            TE.tryCatch(
              async () => {
                await queue.obliterate();
                logger.info({ name }, 'Queue completely obliterated');
              },
              (error) => createQueueError(QueueErrorCode.REMOVE_JOB, name, error as Error),
            ),
          );

        const pause = (): TE.TaskEither<QueueError, void> =>
          pipe(
            TE.tryCatch(
              async () => {
                await queue.pause();
                logger.info({ name }, 'Queue paused');
              },
              (error) => createQueueError(QueueErrorCode.PAUSE_QUEUE, name, error as Error),
            ),
          );

        const resume = (): TE.TaskEither<QueueError, void> =>
          pipe(
            TE.tryCatch(
              async () => {
                await queue.resume();
                logger.info({ name }, 'Queue resumed');
              },
              (error) => createQueueError(QueueErrorCode.RESUME_QUEUE, name, error as Error),
            ),
          );

        const getQueue = (): Queue<T> => queue;

        return {
          getQueue,
          close,
          addJob,
          addBulk,
          removeJob,
          drain,
          clean,
          obliterate,
          pause,
          resume,
          upsertJobScheduler: scheduler.upsertJobScheduler,
          getJobSchedulers: scheduler.getJobSchedulers,
        };
      },
      (error) => createQueueError(QueueErrorCode.CREATE_QUEUE, name, error as Error),
    ),
  );
