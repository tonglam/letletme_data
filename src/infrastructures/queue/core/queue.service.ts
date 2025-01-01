import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueError } from '../../../types/errors.type';
import { BaseJobData } from '../../../types/queue.type';

export interface QueueAdapter<T extends BaseJobData> {
  readonly addJob: (queueName: string, data: T) => TE.TaskEither<QueueError, void>;
  readonly removeJob: (queueName: string, jobId: string) => TE.TaskEither<QueueError, void>;
}

export interface WorkerService {
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
}

export interface SequentialQueueService<T extends BaseJobData> {
  readonly addJob: (queueName: string, data: T) => TE.TaskEither<QueueError, void>;
  readonly removeJob: (queueName: string, jobId: string) => TE.TaskEither<QueueError, void>;
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
}

export const createQueueService = <T extends BaseJobData>(
  queueAdapter: QueueAdapter<T>,
  workerService: WorkerService,
): TE.TaskEither<QueueError, SequentialQueueService<T>> =>
  pipe(
    TE.Do,
    TE.map(() => ({
      addJob: (queueName: string, data: T) =>
        pipe(
          queueAdapter.addJob(queueName, data),
          TE.mapLeft((error: QueueError) => error),
        ),
      removeJob: (queueName: string, jobId: string) =>
        pipe(
          queueAdapter.removeJob(queueName, jobId),
          TE.mapLeft((error: QueueError) => error),
        ),
      startWorker: () => workerService.start(),
      stopWorker: () => workerService.stop(),
    })),
  );
