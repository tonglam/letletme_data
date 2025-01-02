import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../config/queue/queue.config';
import { SequentialQueueService } from '../../../infrastructure/queue/core/queue.service';
import { QueueError } from '../../../types/errors.type';
import { BaseJobData } from '../../../types/queue.type';
import { type MetaJobData } from '../../types';

export interface EventsService {
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
}

export interface EventsJobService extends EventsService {
  readonly queueService: SequentialQueueService<MetaJobData>;
}

export const createEventsProcessor = (
  service: EventsService,
): SequentialQueueService<BaseJobData> => ({
  addJob: () => TE.right(undefined),
  removeJob: () => TE.right(undefined),
  startWorker: () => service.startWorker(),
  stopWorker: () => service.stopWorker(),
});

export const createEventsJobService = (
  queueService: SequentialQueueService<BaseJobData>,
): EventsJobService => ({
  queueService: {
    ...queueService,
    addJob: (queueName: string, data: MetaJobData) => queueService.addJob(queueName, data),
    removeJob: queueService.removeJob,
    startWorker: queueService.startWorker,
    stopWorker: queueService.stopWorker,
  },
  startWorker: () => queueService.startWorker(),
  stopWorker: () => queueService.stopWorker(),
});

export const initializeEventsQueue = (
  config: QueueConfig,
  service: EventsService,
): TE.TaskEither<QueueError, EventsJobService> =>
  pipe(
    TE.Do,
    TE.bind('processor', () => TE.right(createEventsProcessor(service))),
    TE.map(({ processor }) => createEventsJobService(processor)),
  );
