import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createWorkerAdapter } from '../../infrastructures/queue/core/worker.adapter';
import { JobProcessor, QueueConnection } from '../../infrastructures/queue/types';
import { QueueError } from '../../types/errors.type';
import { MetaJobData } from '../jobs/processors/meta.processor';

export interface WorkerService<T extends MetaJobData> {
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
  readonly jobType: T['type'];
}

export const createWorkerService = <T extends MetaJobData>(
  queueName: string,
  connection: QueueConnection,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, WorkerService<T>> =>
  pipe(
    createWorkerAdapter<T>(queueName, connection, processor),
    TE.map((worker) => ({
      start: () => worker.start(),
      stop: () => worker.stop(),
      jobType: 'BOOTSTRAP' as T['type'],
    })),
  );

// Usage example:
// const workerService = await createWorkerService(
//   'meta',
//   connection,
//   createMetaProcessor(metaService),
// )();
