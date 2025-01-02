import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../config/queue/queue.config';
import { QueueError } from '../../../types/errors.type';
import { BaseJobData, JobProcessor, WorkerAdapter } from '../../../types/queue.type';
import { createWorkerAdapter } from './worker.adapter';

export interface WorkerService<T extends BaseJobData> {
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
  readonly jobType: T['type'];
}

export const createWorkerService = <T extends BaseJobData>(
  queueName: string,
  config: QueueConfig,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, WorkerService<T>> =>
  pipe(
    createWorkerAdapter(queueName, config.connection, processor),
    TE.map((worker: WorkerAdapter) => ({
      start: () => worker.start(),
      stop: () => worker.stop(),
      jobType: queueName as T['type'],
    })),
  );
