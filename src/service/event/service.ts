// Event Service Module
// Provides business logic for Event operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createEventOperations } from '../../domain/event/operation';
import { EventCache, EventOperations } from '../../domain/event/types';
import { APIError, ServiceError } from '../../types/error.type';
import {
  Event,
  EventId,
  EventRepository,
  EventResponse,
  Events,
  toDomainEvent,
} from '../../types/event.type';
import { createServiceIntegrationError } from '../../utils/error.util';
import { mapDomainError } from '../utils';
import { EventService, EventServiceDependencies, EventServiceOperations } from './types';

// Implementation of service operations
const eventServiceOperations = (domainOps: EventOperations): EventServiceOperations => ({
  findAllEvents: () =>
    pipe(domainOps.getAllEvents(), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      Events
    >,

  findEventById: (id: EventId) =>
    pipe(domainOps.getEventById(id), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      Event | null
    >,

  findCurrentEvent: () =>
    pipe(domainOps.getCurrentEvent(), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      Event | null
    >,

  findNextEvent: () =>
    pipe(domainOps.getNextEvent(), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      Event | null
    >,

  syncEventsFromApi: (bootstrapApi: EventServiceDependencies['bootstrapApi']) =>
    pipe(
      bootstrapApi.getBootstrapEvents(),
      TE.mapLeft((error: APIError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch events from API',
          cause: error,
        }),
      ),
      TE.chain((events: readonly EventResponse[]) =>
        pipe(
          TE.right(events.map(toDomainEvent)),
          TE.chain((domainEvents) =>
            pipe(
              domainOps.deleteAll(),
              TE.mapLeft(mapDomainError),
              TE.chain(() =>
                pipe(domainOps.createEvents(domainEvents), TE.mapLeft(mapDomainError)),
              ),
            ),
          ),
        ),
      ),
    ) as TE.TaskEither<ServiceError, Events>,
});

export const createEventService = (
  bootstrapApi: EventServiceDependencies['bootstrapApi'],
  repository: EventRepository,
  cache: EventCache = {
    warmUp: () => TE.right(undefined),
    cacheEvent: () => TE.right(undefined),
    cacheEvents: () => TE.right(undefined),
    getEvent: () => TE.right(null),
    getAllEvents: () => TE.right([]),
    getCurrentEvent: () => TE.right(null),
    getNextEvent: () => TE.right(null),
  },
): EventService => {
  const domainOps = createEventOperations(repository, cache);
  const ops = eventServiceOperations(domainOps);

  return {
    getEvents: () => ops.findAllEvents(),
    getEvent: (id: EventId) => ops.findEventById(id),
    getCurrentEvent: () => ops.findCurrentEvent(),
    getNextEvent: () => ops.findNextEvent(),
    saveEvents: (events: readonly Event[]) =>
      pipe(domainOps.createEvents(events), TE.mapLeft(mapDomainError)),
    syncEventsFromApi: () => ops.syncEventsFromApi(bootstrapApi),
  };
};
