import { Job, Worker } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../config/queue/queue.config';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import { JobData } from '../../../types/job.type';
import { getQueueLogger } from '../../logger';
import { WorkerOptions, WorkerService } from '../types';

const logger = getQueueLogger();
const isTest = process.env.NODE_ENV === 'test';

export const createWorkerService = <T extends JobData>(
  name: string,
  config: QueueConfig,
  processor: (job: Job<T>) => Promise<void>,
  options: WorkerOptions = {},
): TE.TaskEither<QueueError, WorkerService<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const worker = new Worker<T>(
          name,
          async (job: Job<T>) => {
            if (!isTest) {
              logger.info({ jobId: job.id, type: job.name }, 'Processing job');
            }

            try {
              await processor(job);
              if (!isTest) {
                logger.info({ jobId: job.id, type: job.name }, 'Job completed');
              }
            } catch (error) {
              const queueError = createQueueError(
                QueueErrorCode.PROCESSING_ERROR,
                name,
                error as Error,
              );
              if (!isTest) {
                logger.error(
                  { jobId: job.id, type: job.name, error: queueError },
                  'Job processing failed',
                );
              }
              throw queueError;
            }
          },
          {
            connection: config.consumerConnection,
            concurrency: options.concurrency ?? 1,
            autorun: options.autorun ?? true,
            maxStalledCount: options.maxStalledCount,
            stalledInterval: options.stalledInterval,
          },
        );

        // Wait for worker to be ready before returning
        await new Promise<void>((resolve) => worker.once('ready', resolve));

        worker.on('error', (error: Error) => {
          if (!isTest) {
            logger.error({ name, error }, 'Worker error occurred');
          }
        });

        const start = (): TE.TaskEither<QueueError, void> =>
          pipe(
            TE.tryCatch(
              async () => {
                await worker.run();
                if (!isTest) {
                  logger.info({ name }, 'Worker started');
                }
              },
              (error) => createQueueError(QueueErrorCode.START_WORKER, name, error as Error),
            ),
          );

        const stop = (): TE.TaskEither<QueueError, void> =>
          pipe(
            TE.tryCatch(
              async () => {
                await worker.close();
                if (!isTest) {
                  logger.info({ name }, 'Worker stopped');
                }
              },
              (error) => createQueueError(QueueErrorCode.STOP_WORKER, name, error as Error),
            ),
          );

        return {
          start,
          stop,
          getWorker: () => worker,
          close: () => stop(),
          pause: (force?: boolean): TE.TaskEither<QueueError, void> =>
            pipe(
              TE.tryCatch(
                async () => {
                  await worker.pause(force);
                  if (!isTest) {
                    logger.info({ name }, 'Worker paused');
                  }
                },
                (error) => createQueueError(QueueErrorCode.PAUSE_QUEUE, name, error as Error),
              ),
            ),
          resume: (): TE.TaskEither<QueueError, void> =>
            pipe(
              TE.tryCatch(
                async () => {
                  await worker.resume();
                  if (!isTest) {
                    logger.info({ name }, 'Worker resumed');
                  }
                },
                (error) => createQueueError(QueueErrorCode.RESUME_QUEUE, name, error as Error),
              ),
            ),
          setConcurrency: (concurrency: number) => {
            worker.concurrency = concurrency;
            if (!isTest) {
              logger.info({ name, concurrency }, 'Worker concurrency updated');
            }
          },
        };
      },
      (error) => createQueueError(QueueErrorCode.CREATE_WORKER, name, error as Error),
    ),
  );
