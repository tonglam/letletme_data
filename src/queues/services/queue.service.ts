import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../configs/queue/queue.config';
import { createQueueAdapter } from '../../infrastructures/queue/core/queue.adapter';
import { QueueError } from '../../types/errors.type';
import { BaseJobData, JobProcessor } from '../../types/queue.type';
import { createMetaProcessor, MetaJobData, MetaService } from '../jobs/processors/meta.processor';
import { createWorkerService, WorkerService } from './worker.service';

export interface QueueService<T extends BaseJobData> {
  readonly addJob: (data: T) => TE.TaskEither<QueueError, void>;
  readonly removeJob: (jobId: string) => TE.TaskEither<QueueError, void>;
  readonly worker: WorkerService<T>;
}

export const createQueueService = <T extends BaseJobData>(
  config: QueueConfig,
  processor: JobProcessor<T>,
): TE.TaskEither<QueueError, QueueService<T>> =>
  pipe(
    TE.Do,
    TE.bind('queue', () => createQueueAdapter<T>(config.name)),
    TE.bind('worker', () => createWorkerService<T>(config.name, config.connection, processor)),
    TE.map(({ queue, worker }) => ({
      addJob: (data: T) =>
        pipe(
          queue.addJob(data),
          TE.map(() => undefined),
        ),
      removeJob: (jobId: string) => queue.removeJob(jobId),
      worker,
    })),
  );

export const createMetaQueueService = (
  config: QueueConfig,
  metaService: MetaService,
): TE.TaskEither<QueueError, QueueService<MetaJobData>> =>
  createQueueService(config, createMetaProcessor(metaService));

// Usage example:
// const queueService = await createMetaQueueService(queueConfig, metaService)();
// await queueService.worker.start()();
// await queueService.addJob({
//   type: JobType.META,
//   timestamp: new Date(),
//   data: { operation: JobOperationType.CREATE, type: MetaJobType.BOOTSTRAP },
// })();
