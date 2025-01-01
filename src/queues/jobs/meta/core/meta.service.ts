import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { QueueConfig } from '../../../../configs/queue/queue.config';
import {
  createQueueService,
  QueueService,
} from '../../../../infrastructures/queue/core/queue.service';
import { QueueError } from '../../../../types/errors.type';
import { JobType } from '../../../../types/queue.type';
import { MetaJobData, MetaService } from '../../../types';
import { createMetaProcessor } from './meta.processor';

// Meta Job Service
export interface MetaJobService {
  readonly queueService: QueueService<MetaJobData>;
  readonly scheduleEventsSync: () => TE.TaskEither<QueueError, void>;
  readonly scheduleCleanup: () => TE.TaskEither<QueueError, void>;
}

export const createMetaJobService = (
  config: QueueConfig,
  metaService: MetaService,
): TE.TaskEither<QueueError, MetaJobService> =>
  pipe(
    createQueueService(config, createMetaProcessor(metaService)),
    TE.map((queueService) => ({
      queueService,
      scheduleEventsSync: () =>
        queueService.addJob({
          type: JobType.META,
          timestamp: new Date(),
          data: {
            operation: 'SYNC',
            type: 'EVENTS',
          },
        }),
      scheduleCleanup: () =>
        queueService.addJob({
          type: JobType.META,
          timestamp: new Date(),
          data: {
            operation: 'CLEANUP',
            type: 'CLEANUP',
          },
        }),
    })),
  );
