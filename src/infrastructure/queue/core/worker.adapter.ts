import { Worker, WorkerOptions } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QUEUE_CONSTANTS } from '../../../config/queue/queue.config';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import {
  BaseJobData,
  JobProcessor,
  MultiWorkerAdapter,
  QueueConnection,
  WorkerAdapter,
} from '../../../types/queue.type';
import { getQueueLogger } from '../../logger';

const logger = getQueueLogger();

// Create worker options with defaults from config
const createWorkerOptions = (
  connection: QueueConnection,
  options?: {
    concurrency?: number;
    lockDuration?: number;
  },
): WorkerOptions => ({
  connection: {
    host: connection.host,
    port: connection.port,
    password: connection.password,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 1000, 3000),
  },
  autorun: false,
  concurrency: options?.concurrency ?? 1,
  lockDuration: options?.lockDuration ?? QUEUE_CONSTANTS.LOCK_DURATION,
  maxStalledCount: 3,
});

// Basic Worker Adapter (1:1 Pattern)
export const createWorkerAdapter = <T extends BaseJobData>(
  name: string,
  connection: QueueConnection,
  processor: JobProcessor<T>,
  options?: WorkerOptions,
): TE.TaskEither<QueueError, WorkerAdapter> =>
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
          options ?? createWorkerOptions(connection),
        );

        // Setup basic logging
        worker.on('completed', (job) => {
          logger.info({ jobId: job.id }, 'Job completed successfully');
        });

        worker.on('failed', (job, error) => {
          logger.error({ jobId: job?.id, error }, 'Job failed');
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

// Scalable Worker Adapter (1:N Pattern)
export const createScalableWorkerAdapter = <T extends BaseJobData>(
  name: string,
  connection: QueueConnection,
  processor: JobProcessor<T>,
  options: {
    numWorkers: number;
    concurrency: number;
  },
): TE.TaskEither<QueueError, MultiWorkerAdapter> =>
  pipe(
    TE.Do,
    TE.bind('workers', () =>
      pipe(
        Array.from({ length: options.numWorkers }, () =>
          createWorkerAdapter(
            name,
            connection,
            processor,
            createWorkerOptions(connection, { concurrency: options.concurrency }),
          ),
        ),
        TE.sequenceArray,
      ),
    ),
    TE.map(({ workers }) => ({
      workers: workers.map((w) => w.worker),
      start: () =>
        pipe(
          TE.sequenceArray(workers.map((w) => w.start())),
          TE.map(() => undefined as void),
          TE.mapLeft(
            (error): QueueError => ({
              type: 'QUEUE_ERROR',
              code: QueueErrorCode.START_WORKER,
              message: 'Failed to start workers',
              queueName: name,
              cause: error instanceof Error ? error : undefined,
            }),
          ),
        ),
      stop: () =>
        pipe(
          TE.sequenceArray(workers.map((w) => w.stop())),
          TE.map(() => undefined as void),
          TE.mapLeft(
            (error): QueueError => ({
              type: 'QUEUE_ERROR',
              code: QueueErrorCode.STOP_WORKER,
              message: 'Failed to stop workers',
              queueName: name,
              cause: error instanceof Error ? error : undefined,
            }),
          ),
        ),
    })),
  );

// Sequential Worker Adapter (N:1 Pattern)
export const createSequentialWorkerAdapter = <T extends BaseJobData>(
  names: string[],
  connection: QueueConnection,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, WorkerAdapter> =>
  pipe(
    createWorkerAdapter(
      names[0], // Use first queue name as primary
      connection,
      processor,
      createWorkerOptions(connection, { concurrency: 1 }), // Ensure sequential processing
    ),
  );
