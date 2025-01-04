import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getQueueLogger } from '../../../infrastructure/logger';
import { createQueueError, QueueError, QueueErrorCode } from '../../../types/errors.type';
import {
  EventMetaData,
  EventMetaService,
  EventRepository,
  EventWorkerService,
} from '../../../types/job.type';

const logger = getQueueLogger();

const startWorker = (eventWorkerService: EventWorkerService): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        logger.info('Starting events worker');
        await eventWorkerService.start()();
      },
      (error) => createQueueError(QueueErrorCode.START_WORKER, 'events', error as Error),
    ),
  );

const stopWorker = (eventWorkerService: EventWorkerService): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        logger.info('Stopping events worker');
        await eventWorkerService.stop()();
      },
      (error) => createQueueError(QueueErrorCode.STOP_WORKER, 'events', error as Error),
    ),
  );

const cleanup = (): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        logger.info('Cleaning up events');
        // Implement cleanup logic here
        // For example:
        // - Remove old event data
        // - Archive completed events
        // - Clean up related resources
      },
      (error) => createQueueError(QueueErrorCode.PROCESSING_ERROR, 'events', error as Error),
    ),
  );

const syncEvent = (
  eventRepository: EventRepository,
  eventData: EventMetaData,
): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        logger.info({ eventId: eventData.eventId }, 'Syncing event');
        await eventRepository.syncEvent(eventData)();
      },
      (error) => createQueueError(QueueErrorCode.PROCESSING_ERROR, 'events', error as Error),
    ),
  );

export const createEventsMetaService = (
  eventRepository: EventRepository,
  eventWorkerService: EventWorkerService,
): EventMetaService => ({
  startWorker: () => startWorker(eventWorkerService),
  stopWorker: () => stopWorker(eventWorkerService),
  cleanup: () => cleanup(),
  syncEvent: (eventData: EventMetaData) => syncEvent(eventRepository, eventData),
});
