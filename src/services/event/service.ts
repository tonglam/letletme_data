import { createEventOperations } from 'domains/event/operation';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { EventService, EventServiceOperations } from 'services/event/types';
import { EventRepository } from 'src/repositories/event/type';

import { FplBootstrapDataService } from '../../data/types';
import { EventCache, EventOperations } from '../../domains/event/types';
import { Event, EventId, Events } from '../../types/domain/event.type';
import {
  createDomainError,
  DataLayerError,
  DomainErrorCode,
  ServiceError,
} from '../../types/error.type';
import {
  createServiceIntegrationError,
  mapDomainErrorToServiceError,
} from '../../utils/error.util';

const eventServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: EventOperations,
  cache: EventCache,
): EventServiceOperations => {
  const findEventById = (id: EventId): TE.TaskEither<ServiceError, Event> =>
    pipe(
      cache.getAllEvents(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Event with ID ${id} not found in cache after fetching all.`,
          }),
        ),
      )((events) => O.fromNullable(events.find((event) => event.id === id))),
    );

  return {
    findEventById,

    findCurrentEvent: (): TE.TaskEither<ServiceError, Event> =>
      pipe(cache.getCurrentEvent(), TE.mapLeft(mapDomainErrorToServiceError)),

    findLastEvent: (): TE.TaskEither<ServiceError, Event> =>
      pipe(
        cache.getCurrentEvent(),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.map((currentEvent) => (currentEvent.id - 1) as EventId),
        TE.chain(findEventById),
      ),

    findNextEvent: (): TE.TaskEither<ServiceError, Event> =>
      pipe(
        cache.getCurrentEvent(),
        TE.mapLeft(mapDomainErrorToServiceError),
        TE.map((currentEvent) => (currentEvent.id + 1) as EventId),
        TE.chain(findEventById),
      ),

    findAllEvents: (): TE.TaskEither<ServiceError, Events> =>
      pipe(cache.getAllEvents(), TE.mapLeft(mapDomainErrorToServiceError)),

    syncEventsFromApi: (): TE.TaskEither<ServiceError, void> => {
      return pipe(
        fplDataService.getEvents(),
        TE.mapLeft((error: DataLayerError) =>
          createServiceIntegrationError({
            message: 'Failed to fetch/map events via data layer',
            cause: error.cause,
            details: error.details,
          }),
        ),
        TE.chain((eventCreateData) => {
          return pipe(
            domainOps.deleteAllEvents(),
            TE.mapLeft(mapDomainErrorToServiceError),
            TE.chain(() => {
              return pipe(
                domainOps.saveEvents(eventCreateData),
                TE.mapLeft(mapDomainErrorToServiceError),
              );
            }),
            TE.chain((events) => {
              return pipe(
                cache.setAllEvents(events),
                TE.mapLeft(mapDomainErrorToServiceError),
                TE.chain(() => {
                  const currentEvent = events.find((e) => e.isCurrent);
                  if (currentEvent) {
                    return pipe(
                      cache.setCurrentEvent(currentEvent),
                      TE.mapLeft(mapDomainErrorToServiceError),
                    );
                  } else {
                    return TE.right(void 0);
                  }
                }),
                TE.map(() => void 0),
              );
            }),
          );
        }),
      );
    },
  };
};

export const createEventService = (
  fplDataService: FplBootstrapDataService,
  repository: EventRepository,
  cache: EventCache,
): EventService => {
  const domainOps = createEventOperations(repository);
  const ops = eventServiceOperations(fplDataService, domainOps, cache);

  return {
    getEvent: (id: EventId): TE.TaskEither<ServiceError, Event> => ops.findEventById(id),
    getCurrentEvent: (): TE.TaskEither<ServiceError, Event> => ops.findCurrentEvent(),
    getLastEvent: (): TE.TaskEither<ServiceError, Event> => ops.findLastEvent(),
    getNextEvent: (): TE.TaskEither<ServiceError, Event> => ops.findNextEvent(),
    getEvents: (): TE.TaskEither<ServiceError, Events> => ops.findAllEvents(),
    syncEventsFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncEventsFromApi(),
  };
};
