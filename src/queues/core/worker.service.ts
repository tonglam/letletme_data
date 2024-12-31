import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as R from 'fp-ts/Reader';
import * as RTE from 'fp-ts/ReaderTaskEither';
import * as TE from 'fp-ts/TaskEither';
import {
  BaseJobData,
  JobProcessor,
  JobType,
  QueueOperation,
  WorkerAdapter,
  WorkerEnv,
  WorkerRegistry,
} from 'src/types/queue.type';
import { createWorkerAdapter } from '../../infrastructures/queue/core/worker.adapter';
import { executeOnAll } from '../../infrastructures/queue/utils';
import { QueueError } from '../../types/errors.type';
import { createQueueProcessingError } from '../../utils/error.util';

// Core operations
export const initWorker = <T extends BaseJobData>(
  queueName: JobType,
  processor: JobProcessor<T>,
): RTE.ReaderTaskEither<WorkerEnv, QueueError, WorkerAdapter<T>> =>
  pipe(
    RTE.ask<WorkerEnv>(),
    RTE.chainTaskEitherK((env) =>
      pipe(
        createWorkerAdapter(queueName, processor),
        TE.map((adapter) => {
          const newRegistry = {
            ...env.registry,
            [queueName]: adapter as unknown as WorkerAdapter<BaseJobData>,
          };
          return { registry: newRegistry, adapter };
        }),
      ),
    ),
    RTE.map(({ adapter }) => adapter),
  );

export const getWorker = (
  queueName: JobType,
): RTE.ReaderTaskEither<WorkerEnv, QueueError, WorkerAdapter> =>
  pipe(
    RTE.ask<WorkerEnv>(),
    RTE.chainOptionK(() =>
      createQueueProcessingError({
        message: `Worker for queue ${queueName} not initialized`,
        queueName,
        operation: QueueOperation.GET_WORKER,
      }),
    )((env) => O.fromNullable(env.registry[queueName])),
  );

// Worker operations
export const startAll = (): RTE.ReaderTaskEither<WorkerEnv, QueueError, void> =>
  executeOnAll(
    (adapter: WorkerAdapter<BaseJobData>) => adapter.start(),
    QueueOperation.START_WORKER,
  );

export const stopAll = (): RTE.ReaderTaskEither<WorkerEnv, QueueError, void> =>
  executeOnAll((adapter: WorkerAdapter<BaseJobData>) => adapter.stop(), QueueOperation.STOP_WORKER);

// Query operations
export const getStatus: R.Reader<WorkerEnv, Record<string, boolean>> = (env) =>
  Object.entries(env.registry).reduce(
    (acc, [queueName, adapter]) => ({
      ...acc,
      [queueName]: (adapter as WorkerAdapter<BaseJobData>).isRunning(),
    }),
    {},
  );

export const getAllWorkers: R.Reader<WorkerEnv, WorkerRegistry> = (env) => env.registry;

export const hasWorker =
  (queueName: JobType): R.Reader<WorkerEnv, boolean> =>
  (env) =>
    queueName in env.registry;

// Create initial environment
export const createWorkerEnv = (): WorkerEnv => ({
  registry: {} as Record<JobType, WorkerAdapter<BaseJobData>>,
});
