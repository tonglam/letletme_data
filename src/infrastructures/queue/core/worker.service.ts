import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueError } from '../../../types/errors.type';
import { BaseJobData, JobProcessor } from '../../../types/queue.type';
import { QueueConnection } from '../types';
import { createWorkerAdapter } from './worker.adapter';

export interface WorkerService<T extends BaseJobData> {
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
  readonly jobType: T['type'];
}

export const createWorkerService = <T extends BaseJobData>(
  queueName: string,
  connection: QueueConnection,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, WorkerService<T>> =>
  pipe(
    createWorkerAdapter<T>(queueName, connection, processor),
    TE.map((worker) => ({
      start: () => worker.start(),
      stop: () => worker.stop(),
      jobType: queueName as T['type'],
    })),
  );
