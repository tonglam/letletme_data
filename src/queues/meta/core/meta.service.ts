import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../configs/queue/queue.config';
import { SequentialQueueService } from '../../../infrastructures/queue/core/queue.service';
import { QueueError } from '../../../types/errors.type';
import { BaseJobData } from '../../../types/queue.type';
import { type MetaJobData } from '../../types';
import { type MetaService } from './types';

export interface MetaJobService {
  readonly queueService: SequentialQueueService<MetaJobData>;
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
}

export const createMetaProcessor = (service: MetaService): SequentialQueueService<BaseJobData> => ({
  addJob: () => TE.right(undefined),
  removeJob: () => TE.right(undefined),
  startWorker: () => service.startWorker(),
  stopWorker: () => service.stopWorker(),
});

export const createMetaJobService = (
  queueService: SequentialQueueService<BaseJobData>,
): MetaJobService => ({
  queueService: queueService as SequentialQueueService<MetaJobData>,
  startWorker: () => queueService.startWorker(),
  stopWorker: () => queueService.stopWorker(),
});

export const initializeMetaQueue = (
  config: QueueConfig,
  service: MetaService,
): TE.TaskEither<QueueError, MetaJobService> =>
  pipe(
    TE.Do,
    TE.bind('processor', () => TE.right(createMetaProcessor(service))),
    TE.map(({ processor }) => createMetaJobService(processor)),
  );
