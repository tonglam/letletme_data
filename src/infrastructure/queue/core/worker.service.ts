import { Job, Worker } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../config/queue/queue.config';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import { JobData } from '../../../types/job.type';
import { getQueueLogger } from '../../logger';
import { WorkerOptions, WorkerService } from '../types';

const logger = getQueueLogger();

export const createWorkerService = <T extends JobData, R = void>(
  name: string,
  config: QueueConfig,
  processor: (job: Job<T>) => Promise<R>,
  options: WorkerOptions = {},
): TE.TaskEither<QueueError, WorkerService<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const worker = new Worker<T, R>(
          name,
          async (job: Job<T>) => {
            logger.info({ jobId: job.id, type: job.name }, 'Processing job');

            try {
              const result = await processor(job);
              logger.info({ jobId: job.id, type: job.name }, 'Job completed');
              return result;
            } catch (error) {
              const queueError = createQueueError(
                QueueErrorCode.JOB_PROCESSING_ERROR,
                name,
                error as Error,
              );
              logger.error(
                { jobId: job.id, type: job.name, error: queueError },
                'Job processing failed',
              );
              throw queueError;
            }
          },
          {
            connection: config.consumerConnection,
            autorun: false,
            concurrency: options.concurrency || 1,
          },
        );

        // Required error handler to prevent worker from stopping
        worker.on('error', (error: Error) => {
          logger.error({ name, error }, 'Worker error occurred');
        });

        await worker.run();
        logger.info({ name, concurrency: worker.concurrency }, 'Worker started');

        return {
          getWorker: () => worker,
          setConcurrency: (value: number) => {
            worker.concurrency = value;
            logger.info({ name, concurrency: value }, 'Worker concurrency updated');
          },
          close: () =>
            pipe(
              TE.tryCatch(
                async () => {
                  logger.info({ name }, 'Worker closing...');
                  await worker.close();
                  logger.info({ name }, 'Worker closed');
                },
                (error) => createQueueError(QueueErrorCode.CLOSE_WORKER, name, error as Error),
              ),
            ),
          pause: (force?: boolean) =>
            pipe(
              TE.tryCatch(
                async () => {
                  logger.info({ name, force }, 'Worker pausing...');
                  await worker.pause(force);
                  logger.info({ name }, 'Worker paused');
                },
                (error) => createQueueError(QueueErrorCode.PAUSE_WORKER, name, error as Error),
              ),
            ),
          resume: () =>
            pipe(
              TE.tryCatch(
                async () => {
                  logger.info({ name }, 'Worker resuming...');
                  await worker.resume();
                  logger.info({ name }, 'Worker resumed');
                },
                (error) => createQueueError(QueueErrorCode.RESUME_WORKER, name, error as Error),
              ),
            ),
        };
      },
      (error) => createQueueError(QueueErrorCode.CREATE_WORKER, name, error as Error),
    ),
  );
