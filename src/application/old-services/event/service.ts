import { EventCache } from 'domain/event/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { EventCreateInputs, EventRepository } from 'repository/event/types';
import { EventService, EventServiceOperations } from 'service/event/types';
import { Event, EventId, Events } from 'types/domain/event.type';
import { ServiceErrorCode, createServiceError, ServiceError } from 'types/error.type';
import {
  mapCacheErrorToServiceError,
  mapDBErrorToServiceError,
  mapDataLayerErrorToServiceError,
} from 'utils/error.util';

const eventServiceOperations = (
  fplDataService: FplBootstrapDataService,
  repository: EventRepository,
  cache: EventCache,
): EventServiceOperations => {
  const findEventById = (id: EventId): TE.TaskEither<ServiceError, Event> =>
    pipe(
      cache.getAllEvents(),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.chainOptionK(() =>
        createServiceError({
          code: ServiceErrorCode.NOT_FOUND,
          message: `Event with ID ${id} not found in cache after fetching all.`,
        }),
      )((events) => O.fromNullable(events.find((event) => event.id === id))),
    );

  const findCurrentEvent = (): TE.TaskEither<ServiceError, Event> =>
    pipe(cache.getCurrentEvent(), TE.mapLeft(mapCacheErrorToServiceError));

  const findLastEvent = (): TE.TaskEither<ServiceError, Event> =>
    pipe(cache.getLastEvent(), TE.mapLeft(mapCacheErrorToServiceError));

  const findNextEvent = (): TE.TaskEither<ServiceError, Event> =>
    pipe(cache.getNextEvent(), TE.mapLeft(mapCacheErrorToServiceError));

  const findAllEvents = (): TE.TaskEither<ServiceError, Events> =>
    pipe(cache.getAllEvents(), TE.mapLeft(mapCacheErrorToServiceError));

  const findAllDeadlineDates = (): TE.TaskEither<ServiceError, ReadonlyArray<Date>> => {
    return pipe(
      findAllEvents(),
      TE.map((events) =>
        pipe(
          events,
          RA.map((event) => new Date(event.deadlineTime)),
          RA.filter((date) => !isNaN(date.getTime())),
        ),
      ),
    );
  };

  const syncEventsFromApi = (): TE.TaskEither<ServiceError, void> => {
    return pipe(
      fplDataService.getEvents(),
      TE.mapLeft(mapDataLayerErrorToServiceError),
      TE.chainFirstW(() => pipe(repository.deleteAll(), TE.mapLeft(mapDBErrorToServiceError))),
      TE.map((events: Events): EventCreateInputs => [...events]),
      TE.chainW((eventsCreateData: EventCreateInputs) =>
        pipe(
          eventsCreateData.length > 0
            ? repository.saveBatch(eventsCreateData)
            : TE.right([] as Events),
          TE.mapLeft(mapDBErrorToServiceError),
        ),
      ),
      TE.chainFirstW((savedEvents: Events) =>
        pipe(cache.setAllEvents(savedEvents), TE.mapLeft(mapCacheErrorToServiceError)),
      ),
      TE.chain((savedEvents: Events) => {
        const currentEvent = savedEvents.find((e: Event) => e.isCurrent);
        if (currentEvent) {
          return pipe(cache.setCurrentEvent(currentEvent), TE.mapLeft(mapCacheErrorToServiceError));
        }
        return TE.right(undefined);
      }),
      TE.map(() => undefined),
    );
  };

  return {
    findEventById,
    findCurrentEvent,
    findLastEvent,
    findNextEvent,
    findAllEvents,
    findAllDeadlineDates,
    syncEventsFromApi,
  };
};

export const createEventService = (
  fplDataService: FplBootstrapDataService,
  repository: EventRepository,
  cache: EventCache,
): EventService => {
  const ops = eventServiceOperations(fplDataService, repository, cache);

  return {
    getEvent: (id: EventId): TE.TaskEither<ServiceError, Event> => ops.findEventById(id),
    getCurrentEvent: (): TE.TaskEither<ServiceError, Event> => ops.findCurrentEvent(),
    getLastEvent: (): TE.TaskEither<ServiceError, Event> => ops.findLastEvent(),
    getNextEvent: (): TE.TaskEither<ServiceError, Event> => ops.findNextEvent(),
    getEvents: (): TE.TaskEither<ServiceError, Events> => ops.findAllEvents(),
    getDeadlineDates: (): TE.TaskEither<ServiceError, ReadonlyArray<Date>> =>
      ops.findAllDeadlineDates(),
    syncEventsFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncEventsFromApi(),
  };
};
