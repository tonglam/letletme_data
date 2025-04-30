import { createEventOperations } from 'domain/event/operation';
import { EventCache, EventOperations } from 'domain/event/types';

import { FplBootstrapDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { EventRepository } from 'repository/event/types';
import { EventService, EventServiceOperations } from 'service/event/types';
import { FixtureService } from 'service/fixture/types';
import { EventFixtures } from 'types/domain/event-fixture.type';
import { Event, EventId, Events } from 'types/domain/event.type';
import {
  DataLayerError,
  ServiceError,
  ServiceErrorCode,
  createServiceError,
} from 'types/error.type';
import { eqDate, normalizeDate, ordDate } from 'utils/date.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

const eventServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: EventOperations,
  cache: EventCache,
  fixtureService: FixtureService,
): EventServiceOperations => {
  const findEventById = (id: EventId): TE.TaskEither<ServiceError, Event> =>
    pipe(
      cache.getAllEvents(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        createServiceError({
          code: ServiceErrorCode.NOT_FOUND,
          message: `Event with ID ${id} not found in cache after fetching all.`,
        }),
      )((events) => O.fromNullable(events.find((event) => event.id === id))),
    );

  const findCurrentEvent = (): TE.TaskEither<ServiceError, Event> =>
    pipe(cache.getCurrentEvent(), TE.mapLeft(mapDomainErrorToServiceError));

  const findNextEvent = (): TE.TaskEither<ServiceError, Event> =>
    pipe(
      findAllEvents(),
      TE.chain((events) => {
        const currentEventIndex = events.findIndex((e) => e.isCurrent);
        if (currentEventIndex === -1 || currentEventIndex === events.length - 1) {
          return TE.left(
            createServiceError({
              code: ServiceErrorCode.NOT_FOUND,
              message: 'Cannot determine next event.',
            }),
          );
        }
        return TE.right(events[currentEventIndex + 1]);
      }),
    );

  const findLastEvent = (): TE.TaskEither<ServiceError, Event> =>
    pipe(
      findAllEvents(),
      TE.chain((events) => {
        const currentEventIndex = events.findIndex((e) => e.isCurrent);
        if (currentEventIndex <= 0) {
          return TE.left(
            createServiceError({
              code: ServiceErrorCode.NOT_FOUND,
              message: 'Cannot determine last event.',
            }),
          );
        }
        return TE.right(events[currentEventIndex - 1]);
      }),
    );

  const findAllEvents = (): TE.TaskEither<ServiceError, Events> =>
    pipe(cache.getAllEvents(), TE.mapLeft(mapDomainErrorToServiceError));

  const syncEventsFromApi = (): TE.TaskEither<ServiceError, void> => {
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
              domainOps.saveEvents([...eventCreateData]),
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
                  console.warn('No current event found after syncing events from API');
                  return TE.right(undefined);
                }
              }),
              TE.map(() => undefined),
            );
          }),
        );
      }),
    );
  };

  const calculateAfterMatchDayDate = (kickoffTime: Date): Date => {
    const kickoffDate = normalizeDate(kickoffTime);
    const sixAmOnKickoffDay = new Date(kickoffDate);
    sixAmOnKickoffDay.setHours(6, 0, 0, 0);

    if (kickoffTime < sixAmOnKickoffDay) {
      return kickoffDate;
    } else {
      const nextDay = new Date(kickoffDate);
      nextDay.setDate(kickoffDate.getDate() + 1);
      return nextDay;
    }
  };

  const isMatchDay = (eventId: EventId): TE.TaskEither<ServiceError, boolean> => {
    const today = normalizeDate(new Date());
    return pipe(findAllMatchDays(eventId), TE.map(RA.elem(eqDate)(today)));
  };

  const isAfterMatchDay = (eventId: EventId): TE.TaskEither<ServiceError, boolean> => {
    const todayNormalized = normalizeDate(new Date());
    return pipe(
      findAllAfterMatchDays(eventId),
      TE.map(RA.last),
      TE.map(
        O.match(
          () => false,
          (latestAfterMatchDay) => ordDate.compare(todayNormalized, latestAfterMatchDay) > 0,
        ),
      ),
    );
  };

  const isMatchTime = (eventId: EventId): TE.TaskEither<ServiceError, boolean> => {
    const now = new Date();
    return pipe(
      fixtureService.getFixturesByEventId(eventId),
      TE.map((fixtures) =>
        fixtures.some(
          (f) => f.kickoffTime !== null && f.kickoffTime <= now && !f.finished && f.started,
        ),
      ),
    );
  };

  const isSelectTime = (eventId: EventId): TE.TaskEither<ServiceError, boolean> => {
    const now = new Date();

    return pipe(
      isMatchDay(eventId),
      TE.chainW((isMatchDayResult) => {
        if (!isMatchDayResult) {
          return TE.right(false);
        }

        return pipe(
          findEventById(eventId),
          TE.chainEitherK((event) => {
            try {
              const deadlineDate = new Date(event.deadlineTime);
              if (isNaN(deadlineDate.getTime())) {
                return E.left(
                  createServiceError({
                    code: ServiceErrorCode.VALIDATION_ERROR,
                    message: `Invalid deadline time format for event ${eventId}: ${event.deadlineTime}`,
                  }),
                );
              }
              const deadlinePlus30 = new Date(deadlineDate);
              deadlinePlus30.setMinutes(deadlineDate.getMinutes() + 30);
              return E.right(now > deadlinePlus30);
            } catch (error) {
              return E.left(
                createServiceError({
                  code: ServiceErrorCode.UNKNOWN,
                  message: `Error processing deadline time for event ${eventId}: ${event.deadlineTime}`,
                  cause: error instanceof Error ? error : undefined,
                }),
              );
            }
          }),
        );
      }),
    );
  };

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

  const findAllMatchDays = (eventId: EventId): TE.TaskEither<ServiceError, ReadonlyArray<Date>> => {
    return pipe(
      fixtureService.getFixturesByEventId(eventId),
      TE.map((fixtures: EventFixtures) =>
        pipe(
          fixtures,
          RA.filterMap((fixture) => O.fromNullable(fixture.kickoffTime)),
          RA.map(normalizeDate),
          RA.uniq(eqDate),
          RA.sort(ordDate),
        ),
      ),
    );
  };

  const findAllAfterMatchDays = (
    eventId: EventId,
  ): TE.TaskEither<ServiceError, ReadonlyArray<Date>> => {
    return pipe(
      fixtureService.getFixturesByEventId(eventId),
      TE.map((fixtures: EventFixtures) =>
        pipe(
          fixtures,
          RA.filterMap((fixture) => O.fromNullable(fixture.kickoffTime)),
          RA.map(calculateAfterMatchDayDate),
          RA.uniq(eqDate),
          RA.sort(ordDate),
        ),
      ),
    );
  };

  return {
    findEventById,
    findCurrentEvent,
    findLastEvent,
    findNextEvent,
    findAllEvents,
    syncEventsFromApi,
    isMatchDay,
    isAfterMatchDay,
    isMatchTime,
    isSelectTime,
    findAllDeadlineDates,
    findAllMatchDays,
    findAllAfterMatchDays,
  };
};

export const createEventService = (
  fplDataService: FplBootstrapDataService,
  repository: EventRepository,
  cache: EventCache,
  fixtureService: FixtureService,
): EventService => {
  const domainOps = createEventOperations(repository);
  const ops = eventServiceOperations(fplDataService, domainOps, cache, fixtureService);

  return {
    getEvent: (id: EventId): TE.TaskEither<ServiceError, Event> => ops.findEventById(id),
    getCurrentEvent: (): TE.TaskEither<ServiceError, Event> => ops.findCurrentEvent(),
    getLastEvent: (): TE.TaskEither<ServiceError, Event> => ops.findLastEvent(),
    getNextEvent: (): TE.TaskEither<ServiceError, Event> => ops.findNextEvent(),
    getEvents: (): TE.TaskEither<ServiceError, Events> => ops.findAllEvents(),
    syncEventsFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncEventsFromApi(),
    isMatchDay: (eventId: EventId): TE.TaskEither<ServiceError, boolean> => ops.isMatchDay(eventId),
    isAfterMatchDay: (eventId: EventId): TE.TaskEither<ServiceError, boolean> =>
      ops.isAfterMatchDay(eventId),
    isMatchTime: (eventId: EventId): TE.TaskEither<ServiceError, boolean> =>
      ops.isMatchTime(eventId),
    isSelectTime: (eventId: EventId): TE.TaskEither<ServiceError, boolean> =>
      ops.isSelectTime(eventId),
    getDeadlineDates: (): TE.TaskEither<ServiceError, ReadonlyArray<Date>> =>
      ops.findAllDeadlineDates(),
    getMatchDays: (eventId: EventId): TE.TaskEither<ServiceError, ReadonlyArray<Date>> =>
      ops.findAllMatchDays(eventId),
    getAfterMatchDays: (eventId: EventId): TE.TaskEither<ServiceError, ReadonlyArray<Date>> =>
      ops.findAllAfterMatchDays(eventId),
  };
};
