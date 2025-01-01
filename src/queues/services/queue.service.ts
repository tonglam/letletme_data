import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../configs/queue/queue.config';
import { createQueueAdapter } from '../../infrastructures/queue/core/queue.adapter';
import { QueueError } from '../../types/errors.type';
import { createMetaProcessor, MetaJobData, MetaService } from '../jobs/processors/meta.processor';
import { createWorkerService, WorkerService } from './worker.service';

export interface QueueService<T extends MetaJobData> {
  readonly addJob: (data: T) => TE.TaskEither<QueueError, void>;
  readonly worker: WorkerService<T>;
}

export const createQueueService = (
  config: QueueConfig,
  metaService: MetaService,
): TE.TaskEither<QueueError, QueueService<MetaJobData>> =>
  pipe(
    TE.Do,
    TE.bind('queue', () => createQueueAdapter<MetaJobData>(config.name, config.connection)),
    TE.bind('worker', () =>
      createWorkerService(config.name, config.connection, createMetaProcessor(metaService)),
    ),
    TE.map(({ queue, worker }) => ({
      addJob: (data: MetaJobData) =>
        pipe(
          queue.addJob(data),
          TE.map(() => undefined),
        ),
      worker,
    })),
  );

// Usage example:
// const queueService = await createQueueService(connection, metaService)();
// await queueService.worker.start()();
// await queueService.addJob({
//   type: 'BOOTSTRAP',
//   data: { operation: 'SYNC' },
// })();
