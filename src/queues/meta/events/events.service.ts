import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { QUEUE_NAMES, createQueueConfig } from '../../../configs/queue/queue.config';
import {
  QueueService,
  createQueueService,
} from '../../../infrastructures/queue/core/queue.service';
import { EventService } from '../../../services/events/types';
import { eventWorkflows } from '../../../services/events/workflow';
import { QueueError } from '../../../types/errors.type';
import { MetaJobData } from '../../types';
import { createEventsProcessor } from './events.processor';

export interface EventsJobService {
  readonly syncEvents: () => TE.TaskEither<QueueError, void>;
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
}

export const createEventsJobService = (
  queueService: QueueService<MetaJobData>,
): EventsJobService => ({
  syncEvents: () =>
    queueService.addJob({
      type: 'META',
      timestamp: new Date(),
      data: {
        operation: 'SYNC',
        type: 'EVENTS',
      },
    }),
  startWorker: () => queueService.startWorker(),
  stopWorker: () => queueService.stopWorker(),
});

export const initializeEventsQueue = (
  eventService: EventService,
): TE.TaskEither<QueueError, EventsJobService> => {
  // Create workflow service
  const workflows = eventWorkflows(eventService);

  // Create queue config
  const queueConfig = createQueueConfig(QUEUE_NAMES.META);

  // Create queue service with processor
  return pipe(
    createQueueService(queueConfig, createEventsProcessor(workflows)),
    TE.map(createEventsJobService),
  );
};
