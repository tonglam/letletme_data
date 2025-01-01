import { Worker, WorkerOptions } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import {
  BaseJobData,
  JobProcessor,
  QueueConnection,
  WorkerAdapter,
} from '../../../types/queue.type';

const createWorkerOptions = (connection: QueueConnection): WorkerOptions => ({
  connection: {
    host: connection.host,
    port: connection.port,
    password: connection.password,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 1000, 3000),
  },
  autorun: true,
  concurrency: 1,
  lockDuration: 30000,
  maxStalledCount: 3,
});

export const createWorkerAdapter = <T extends BaseJobData>(
  name: string,
  connection: QueueConnection,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, WorkerAdapter<T>> =>
  pipe(
    TE.tryCatch(
      async () => {
        const worker = new Worker(
          name,
          async (job) => {
            const result = await processor(job)();
            if (result._tag === 'Left') {
              throw result.left;
            }
          },
          createWorkerOptions(connection),
        );

        // Setup basic logging
        worker.on('completed', (job) => {
          console.log(`Job ${job.id} completed successfully`);
        });

        worker.on('failed', (job, error) => {
          console.error(`Job ${job?.id} failed:`, error);
        });

        return {
          worker,
          start: () =>
            TE.tryCatch(
              async () => {
                if (!worker.isRunning()) {
                  await worker.run();
                }
              },
              (error) => createQueueError(QueueErrorCode.START_WORKER, name, error as Error),
            ),
          stop: () =>
            TE.tryCatch(
              async () => {
                await worker.close();
              },
              (error) => createQueueError(QueueErrorCode.STOP_WORKER, name, error as Error),
            ),
        };
      },
      (error) => createQueueError(QueueErrorCode.CREATE_WORKER, name, error as Error),
    ),
  );
