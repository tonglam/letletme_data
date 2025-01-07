import { JobsOptions, Queue } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { z } from 'zod';
import { createQueueError, QueueError, QueueErrorCode } from '../../../types/errors.type';
import { MetaJobData } from '../../../types/job.type';
import { QueueConfig } from '../../../types/queue.type';
import { getQueueLogger } from '../../logger';
import { BullMQJobStatus, BullMQQueueMethods, JobOptions, QueueService } from '../types';
import { createSchedulerService } from './scheduler.service';

const logger = getQueueLogger();

const JobDataSchema = z
  .object({
    type: z.literal('META'),
    timestamp: z.date(),
    data: z.object({
      operation: z.literal('SYNC'),
      metaType: z.union([z.literal('EVENTS'), z.literal('PHASES'), z.literal('TEAMS')]),
    }),
    name: z.literal('meta'),
  })
  .transform((data) => ({
    ...data,
    data: data.data ?? {},
  }));

const validateJobData = (data: unknown): TE.TaskEither<QueueError, MetaJobData> =>
  pipe(
    TE.tryCatch(
      async () => {
        const result = JobDataSchema.safeParse(data);
        if (!result.success) {
          throw new Error(`Invalid job data: ${result.error.message}`);
        }
        return result.data as MetaJobData;
      },
      (error) => createQueueError(QueueErrorCode.INVALID_JOB_DATA, 'validation', error as Error),
    ),
  );

const convertToJobOptions = (options?: JobOptions): JobsOptions => ({
  priority: options?.priority,
  lifo: options?.lifo,
  delay: options?.delay,
  repeat: options?.repeat,
  jobId: options?.jobId,
  timestamp: options?.timestamp,
  attempts: options?.attempts,
  backoff: options?.backoff,
});

export const createQueueServiceImpl = <T extends MetaJobData>(
  name: string,
  config: QueueConfig,
): TE.TaskEither<QueueError, QueueService<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        type QueueType = Queue<T>;
        const queue = new Queue<T>(name, {
          connection: config.connection,
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: true,
          },
        }) as QueueType;

        logger.info({ name }, 'Queue service initialized');

        const scheduler = createSchedulerService<T>(name, queue);

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
                  await (queue as Queue<T> & BullMQQueueMethods<T>).add(
                    data.name,
                    data,
                    convertToJobOptions(options),
                  );
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

                // Validate all jobs first
                await Promise.all(jobs.map((job) => validateJobData(job.data)()));

                const bulkJobs = jobs.map((job) => ({
                  name: job.data.type,
                  data: job.data,
                  opts: convertToJobOptions(job.options),
                }));

                await (queue as Queue<T> & BullMQQueueMethods<T>).addBulk(bulkJobs);
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
