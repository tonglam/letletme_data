import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { BootstrapApi } from '../../../domains/bootstrap/operations';
import { EventRepositoryOperations } from '../../../domains/events/types';
import { getQueueLogger } from '../../../infrastructures/logger';
import { ServiceError } from '../../../types/errors.type';
import { Event, toDomainEvent } from '../../../types/events.type';
import {
  createServiceIntegrationError,
  createServiceOperationError,
} from '../../../utils/error.util';

const logger = getQueueLogger();

export interface EventsJobService {
  readonly syncEvents: () => Promise<void>;
}

export const createEventsJobService = (
  bootstrapApi: BootstrapApi,
  eventRepository: EventRepositoryOperations,
): EventsJobService => {
  const fetchAndSaveEvents = (): TE.TaskEither<ServiceError, readonly Event[]> =>
    pipe(
      TE.tryCatch(
        () => bootstrapApi.getBootstrapData(),
        (error) =>
          createServiceIntegrationError({
            message: 'Failed to fetch events from API',
            cause: error as Error,
          }),
      ),
      TE.map((response) => response.events.map(toDomainEvent)),
      TE.chain((events) =>
        pipe(
          eventRepository.createMany(events),
          TE.mapLeft((error) =>
            createServiceOperationError({
              message: 'Failed to save events to database',
              cause: error,
            }),
          ),
          TE.map((savedEvents) => savedEvents.map(toDomainEvent)),
        ),
      ),
    );

  return {
    syncEvents: async () => {
      logger.info('Starting events sync');

      const result = await fetchAndSaveEvents()();

      if (result._tag === 'Left') {
        logger.error({ error: result.left }, 'Events sync failed');
        throw result.left;
      }

      logger.info({ count: result.right.length }, 'Events sync completed');
    },
  };
};
