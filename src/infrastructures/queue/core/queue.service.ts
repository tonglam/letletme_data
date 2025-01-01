import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../configs/queue/queue.config';
import { QueueError } from '../../../types/errors.type';
import { BaseJobData, JobProcessor } from '../../../types/queue.type';
import { createQueueAdapter } from './queue.adapter';
import { createWorkerAdapter } from './worker.adapter';

export interface QueueService<T extends BaseJobData> {
  readonly addJob: (data: T) => TE.TaskEither<QueueError, void>;
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
}

export const createQueueService = <T extends BaseJobData>(
  config: QueueConfig,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, QueueService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queue', () => createQueueAdapter<T>(config.name)),
    TE.bind('worker', () => createWorkerAdapter<T>(config.name, config.connection, processor)),
    TE.map(({ queue, worker }) => ({
      addJob: (data: T) =>
        pipe(
          queue.addJob(data),
          TE.map(() => undefined),
        ),
      removeJob: (jobId: string) => queue.removeJob(jobId),
      startWorker: () => worker.start(),
      stopWorker: () => worker.stop(),
    })),
  );
