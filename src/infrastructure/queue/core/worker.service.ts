import { Job, Worker } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QUEUE_CONFIG } from '../../../config/queue/queue.config';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/error.type';
import { MetaJobData } from '../../../types/job.type';
import { getQueueLogger } from '../../logger';
import { WorkerOptions, WorkerService } from '../types';

const logger = getQueueLogger();

export const createWorkerService = <T extends MetaJobData>(
  name: string,
  processor: (job: Job<T>) => Promise<void>,
  options: WorkerOptions = {},
): TE.TaskEither<QueueError, WorkerService<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const worker = new Worker<T>(name, processor, {
          connection: {
            host: QUEUE_CONFIG.REDIS.HOST,
            port: QUEUE_CONFIG.REDIS.PORT,
            password: QUEUE_CONFIG.REDIS.PASSWORD,
          },
          concurrency: options.concurrency ?? 3,
          maxStalledCount: options.maxStalledCount ?? 1,
          stalledInterval: options.stalledInterval ?? 30000,
          lockDuration: 10000,
          settings: {
            backoffStrategy: (attemptsMade: number) => {
              return Math.min(1000 * Math.pow(2, attemptsMade), 30000);
            },
          },
          limiter: options.limiter,
          autorun: false, // Prevent auto-start
          prefix: process.env.NODE_ENV === 'test' ? 'test' : 'bull',
        });

        // Add more events for debugging
        worker.on('error', (error) => {
          logger.error({ name, error }, 'Worker encountered an error');
        });

        worker.on('stalled', (jobId) => {
          logger.warn({ name, jobId }, 'Job stalled');
        });

        worker.on('drained', () => {
          logger.info({ name }, 'Queue is drained, no more jobs to process');
        });

        // Track active jobs for proper cleanup
        const activeJobs = new Set<string>();
        worker.on('active', (job) => {
          if (job.id) {
            activeJobs.add(job.id);
            logger.info({ name, jobId: job.id }, 'Job started processing');
          }
        });
        worker.on('completed', (job) => {
          if (job.id) {
            activeJobs.delete(job.id);
            logger.info({ name, jobId: job.id }, 'Job completed');
          }
        });
        worker.on('failed', (job, error) => {
          if (job?.id) {
            activeJobs.delete(job.id);
            logger.error({ name, jobId: job.id, error }, 'Job failed');
          }
        });

        // Wait for worker to be ready before returning
        await new Promise<void>((resolve) => worker.once('ready', resolve));

        return {
          start: (): TE.TaskEither<QueueError, void> =>
            pipe(
              TE.tryCatch(
                async () => {
                  // Start worker and wait for it to be ready
                  await worker.run();
                  // Wait for worker to be ready
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  logger.info({ name }, 'Worker started and running');
                },
                (error) => createQueueError(QueueErrorCode.START_WORKER, name, error as Error),
              ),
            ),
          stop: (): TE.TaskEither<QueueError, void> =>
            pipe(
              TE.tryCatch(
                async () => {
                  await worker.pause(true);
                  logger.info({ name }, 'Worker stopped');
                },
                (error) => createQueueError(QueueErrorCode.STOP_WORKER, name, error as Error),
              ),
            ),
          getWorker: () => worker,
          close: (): TE.TaskEither<QueueError, void> =>
            pipe(
              TE.tryCatch(
                async () => {
                  // Wait for active jobs to complete before closing
                  while (activeJobs.size > 0) {
                    logger.info(
                      { name, activeJobs: Array.from(activeJobs) },
                      'Waiting for active jobs to complete',
                    );
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                  await worker.close();
                  logger.info({ name }, 'Worker closed');
                },
                (error) => createQueueError(QueueErrorCode.STOP_WORKER, name, error as Error),
              ),
            ),
          pause: (force?: boolean): TE.TaskEither<QueueError, void> =>
            pipe(
              TE.tryCatch(
                async () => {
                  await worker.pause(force);
                  // Wait for the pause to take effect
                  await new Promise((resolve) => setTimeout(resolve, 500));
                  // Verify pause state
                  const isPaused = await worker.isPaused();
                  if (!isPaused) {
                    throw new Error('Worker failed to pause');
                  }
                  logger.info({ name }, 'Worker paused');
                },
                (error) => createQueueError(QueueErrorCode.PAUSE_QUEUE, name, error as Error),
              ),
            ),
          resume: (): TE.TaskEither<QueueError, void> =>
            pipe(
              TE.tryCatch(
                async () => {
                  await worker.resume();
                  // Wait for the resume to take effect
                  await new Promise((resolve) => setTimeout(resolve, 500));
                  // Verify resume state
                  const isPaused = await worker.isPaused();
                  if (isPaused) {
                    throw new Error('Worker failed to resume');
                  }
                  logger.info({ name }, 'Worker resumed');
                },
                (error) => createQueueError(QueueErrorCode.RESUME_QUEUE, name, error as Error),
              ),
            ),
          setConcurrency: (concurrency: number) => {
            if (concurrency < 1) {
              throw new Error('Concurrency must be greater than 0');
            }
            worker.opts.concurrency = concurrency;
            worker.concurrency = concurrency;
            logger.info({ name, concurrency }, 'Worker concurrency updated');
          },
        };
      },
      (error) => createQueueError(QueueErrorCode.CREATE_WORKER, name, error as Error),
    ),
  );
