import { Job, Worker } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import { MetaJobData } from '../../../types/job.type';
import { QueueConfig } from '../../../types/queue.type';
import { getQueueLogger } from '../../logger';
import { WorkerOptions, WorkerService } from '../types';

const logger = getQueueLogger();

export const createWorkerService = <T extends MetaJobData>(
  name: string,
  config: QueueConfig,
  processor: (job: Job<T>) => Promise<void>,
  options: WorkerOptions = {},
): TE.TaskEither<QueueError, WorkerService<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const worker = new Worker<T>(name, processor, {
          connection: config.connection,
          concurrency: options.concurrency ?? 1,
          maxStalledCount: options.maxStalledCount ?? 1,
          stalledInterval: options.stalledInterval ?? 30000,
          lockDuration: 30000, // 30 seconds
          settings: {
            backoffStrategy: (attemptsMade: number) => {
              return Math.min(1000 * Math.pow(2, attemptsMade), 30000);
            },
          },
        });

        // Wait for worker to be ready before returning
        await new Promise<void>((resolve) => worker.once('ready', resolve));

        return {
          start: (): TE.TaskEither<QueueError, void> =>
            pipe(
              TE.tryCatch(
                async () => {
                  // Worker runs automatically when created
                  logger.info({ name }, 'Worker started');
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
                  logger.info({ name }, 'Worker resumed');
                },
                (error) => createQueueError(QueueErrorCode.RESUME_QUEUE, name, error as Error),
              ),
            ),
          setConcurrency: (concurrency: number) => {
            worker.concurrency = concurrency;
            logger.info({ name, concurrency }, 'Worker concurrency updated');
          },
        };
      },
      (error) => createQueueError(QueueErrorCode.CREATE_WORKER, name, error as Error),
    ),
  );
