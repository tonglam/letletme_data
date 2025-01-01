import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { QueueConfig } from '../../../configs/queue/queue.config';
import {
  QueueService,
  createQueueService,
} from '../../../infrastructures/queue/core/queue.service';
import { QueueError } from '../../../types/errors.type';
import { MetaJobData, MetaService } from '../../types';
import { createMetaProcessor } from './meta.processor';

export interface MetaJobService {
  readonly queueService: QueueService<MetaJobData>;
  readonly addSyncJob: () => TE.TaskEither<QueueError, void>;
  readonly addCleanupJob: () => TE.TaskEither<QueueError, void>;
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
}

export const createMetaJobService = (queueService: QueueService<MetaJobData>): MetaJobService => ({
  queueService,
  addSyncJob: () =>
    queueService.addJob({
      type: 'META',
      timestamp: new Date(),
      data: {
        operation: 'SYNC',
        type: 'EVENTS',
      },
    }),
  addCleanupJob: () =>
    queueService.addJob({
      type: 'META',
      timestamp: new Date(),
      data: {
        operation: 'CLEANUP',
        type: 'CLEANUP',
      },
    }),
  startWorker: () => queueService.startWorker(),
  stopWorker: () => queueService.stopWorker(),
});

export const initializeMetaQueue = (
  config: QueueConfig,
  service: MetaService,
): TE.TaskEither<QueueError, MetaJobService> =>
  pipe(createQueueService(config, createMetaProcessor(service)), TE.map(createMetaJobService));
