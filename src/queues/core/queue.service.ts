import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as R from 'fp-ts/Reader';
import * as RTE from 'fp-ts/ReaderTaskEither';
import * as TE from 'fp-ts/TaskEither';
import { createQueueAdapter } from '../../infrastructures/queue/core/queue.adapter';
import { QueueAdapter, QueueEnv, QueueRegistry } from '../../infrastructures/queue/types';
import { QueueError, QueueOperation, QueueOperationErrorCode } from '../../types/errors.type';
import { createQueueProcessingError } from '../../utils/error.util';

// Core operations
export const initQueue = (
  queueName: string,
): RTE.ReaderTaskEither<QueueEnv, QueueError, QueueAdapter> =>
  pipe(
    RTE.ask<QueueEnv>(),
    RTE.chainTaskEitherK((env) =>
      pipe(
        createQueueAdapter(queueName),
        TE.map((adapter) => {
          const newRegistry = { ...env.registry, [queueName]: adapter };
          return { registry: newRegistry, adapter };
        }),
      ),
    ),
    RTE.map(({ adapter }) => adapter),
  );

export const getQueue = (
  queueName: string,
): RTE.ReaderTaskEither<QueueEnv, QueueError, QueueAdapter> =>
  pipe(
    RTE.ask<QueueEnv>(),
    RTE.chainOptionK(() =>
      createQueueProcessingError({
        message: `Queue ${queueName} not initialized`,
        queueName,
        operation: QueueOperation.GET_QUEUE,
      }),
    )((env) => O.fromNullable(env.registry[queueName])),
  );

// Helper for executing operations on all queues
const executeOnAll = (
  operation: (adapter: QueueAdapter) => TE.TaskEither<QueueError, void>,
  errorCode: QueueOperationErrorCode,
  opType: QueueOperation,
): RTE.ReaderTaskEither<QueueEnv, QueueError, void> =>
  pipe(
    RTE.ask<QueueEnv>(),
    RTE.chainTaskEitherK((env) =>
      pipe(
        TE.sequenceArray(Object.values(env.registry).map(operation)),
        TE.mapLeft((error) =>
          createQueueProcessingError({
            message: `Failed to execute ${errorCode}`,
            queueName: 'all',
            operation: opType,
            cause: error,
          }),
        ),
        TE.map(() => undefined),
      ),
    ),
  );

// Queue operations
export const pauseAll = (): RTE.ReaderTaskEither<QueueEnv, QueueError, void> =>
  executeOnAll(
    (adapter) => adapter.pauseQueue(),
    QueueOperationErrorCode.QUEUE_PAUSE_ALL_ERROR,
    QueueOperation.PAUSE_QUEUE,
  );

export const resumeAll = (): RTE.ReaderTaskEither<QueueEnv, QueueError, void> =>
  executeOnAll(
    (adapter) => adapter.resumeQueue(),
    QueueOperationErrorCode.QUEUE_RESUME_ALL_ERROR,
    QueueOperation.RESUME_QUEUE,
  );

export const cleanupAll = (): RTE.ReaderTaskEither<QueueEnv, QueueError, void> =>
  executeOnAll(
    (adapter) => adapter.cleanQueue(),
    QueueOperationErrorCode.QUEUE_CLEANUP_ALL_ERROR,
    QueueOperation.CLEAN_QUEUE,
  );

// Query operations
export const getAllQueues: R.Reader<QueueEnv, QueueRegistry> = (env) => env.registry;

export const hasQueue =
  (queueName: string): R.Reader<QueueEnv, boolean> =>
  (env) =>
    queueName in env.registry;

// Create initial environment
export const createQueueEnv = (): QueueEnv => ({ registry: {} });
