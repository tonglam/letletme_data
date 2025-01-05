// Event Service Module
// Provides business logic for Event operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createEventOperations } from '../../domain/event/operations';
import { EventOperations, EventRepositoryOperations } from '../../domain/event/types';
import { APIError, DomainError, ServiceError } from '../../types/errors.type';
import { Event, EventId, EventResponse, toDomainEvent } from '../../types/events.type';
import { createServiceIntegrationError, createServiceOperationError } from '../../utils/error.util';
import { EventService, EventServiceDependencies, EventServiceOperations } from './types';

// Maps domain errors to service errors
const mapDomainError = (error: DomainError): ServiceError =>
  createServiceOperationError({
    message: error.message,
    cause: error,
  });

// Implementation of service operations
const eventServiceOperations = (domainOps: EventOperations): EventServiceOperations => ({
  findAllEvents: () => pipe(domainOps.getAllEvents(), TE.mapLeft(mapDomainError)),

  findEventById: (id: EventId) => pipe(domainOps.getEventById(id), TE.mapLeft(mapDomainError)),

  findCurrentEvent: () => pipe(domainOps.getCurrentEvent(), TE.mapLeft(mapDomainError)),

  findNextEvent: () => pipe(domainOps.getNextEvent(), TE.mapLeft(mapDomainError)),

  syncEventsFromApi: (bootstrapApi: EventServiceDependencies['bootstrapApi']) =>
    pipe(
      bootstrapApi.getBootstrapEvents(),
      TE.mapLeft((error: APIError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch events from API',
          cause: error,
        }),
      ),
      TE.map((events: readonly EventResponse[]) => events.map(toDomainEvent)),
      TE.chain((events) => pipe(domainOps.createEvents(events), TE.mapLeft(mapDomainError))),
    ),
});

export const createEventService = (
  bootstrapApi: EventServiceDependencies['bootstrapApi'],
  repository: EventRepositoryOperations,
): EventService => {
  const domainOps = createEventOperations(repository);
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
