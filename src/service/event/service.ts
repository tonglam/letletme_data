// Event Service Module
// Provides business logic for Event operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { BootstrapApi } from '../../domain/bootstrap/operations';
import { EventCache, EventRepositoryOperations } from '../../domain/event/types';
import { ServiceError } from '../../types/errors.type';
import { Event, EventId, EventResponse, toDomainEvent } from '../../types/events.type';
import { createServiceIntegrationError, createServiceOperationError } from '../../utils/error.util';
import { createEventServiceCache } from './cache';

export interface EventService {
  readonly getEvents: () => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly saveEvents: (events: readonly Event[]) => TE.TaskEither<ServiceError, readonly Event[]>;
}

const findAllEvents = (
  repository: EventRepositoryOperations,
  cache: EventCache,
): TE.TaskEither<ServiceError, readonly Event[]> =>
  pipe(
    cache.getAllEvents(),
    TE.mapLeft((error) =>
      createServiceIntegrationError({
        message: 'Failed to fetch events from cache',
        cause: error,
      }),
    ),
    TE.chain((cached) =>
      cached.length > 0
        ? TE.right(cached)
        : pipe(
            repository.findAll(),
            TE.mapLeft((error) =>
              createServiceOperationError({
                message: 'Failed to fetch events from repository',
                cause: error,
              }),
            ),
            TE.chain((events) =>
              pipe(events.map(toDomainEvent), (domainEvents) =>
                pipe(
                  cache.cacheEvents(domainEvents),
                  TE.mapLeft((error) =>
                    createServiceIntegrationError({
                      message: 'Failed to cache events',
                      cause: error,
                    }),
                  ),
                  TE.map(() => domainEvents),
                ),
              ),
            ),
          ),
    ),
  );

const findEventById = (
  repository: EventRepositoryOperations,
  cache: EventCache,
  id: EventId,
): TE.TaskEither<ServiceError, Event | null> =>
  pipe(
    cache.getEvent(String(id)),
    TE.mapLeft((error) =>
      createServiceIntegrationError({
        message: `Failed to fetch event ${id} from cache`,
        cause: error,
      }),
    ),
    TE.chain((cached) =>
      cached
        ? TE.right(cached)
        : pipe(
            repository.findById(id),
            TE.mapLeft((error) =>
              createServiceOperationError({
                message: `Failed to fetch event ${id} from repository`,
                cause: error,
              }),
            ),
            TE.map((event) => (event ? toDomainEvent(event) : null)),
            TE.chain((event) =>
              event
                ? pipe(
                    cache.cacheEvent(event),
                    TE.mapLeft((error) =>
                      createServiceIntegrationError({
                        message: `Failed to cache event ${id}`,
                        cause: error,
                      }),
                    ),
                    TE.map(() => event),
                  )
                : TE.right(null),
            ),
          ),
    ),
  );

const findCurrentEvent = (
  repository: EventRepositoryOperations,
  cache: EventCache,
): TE.TaskEither<ServiceError, Event | null> =>
  pipe(
    cache.getCurrentEvent(),
    TE.mapLeft((error) =>
      createServiceIntegrationError({
        message: 'Failed to fetch current event from cache',
        cause: error,
      }),
    ),
    TE.chain((cached) =>
      cached
        ? TE.right(cached)
        : pipe(
            repository.findCurrent(),
            TE.mapLeft((error) =>
              createServiceOperationError({
                message: 'Failed to fetch current event from repository',
                cause: error,
              }),
            ),
            TE.map((event) => (event ? toDomainEvent(event) : null)),
            TE.chain((event) =>
              event
                ? pipe(
                    cache.cacheEvent(event),
                    TE.mapLeft((error) =>
                      createServiceIntegrationError({
                        message: 'Failed to cache current event',
                        cause: error,
                      }),
                    ),
                    TE.map(() => event),
                  )
                : TE.right(null),
            ),
          ),
    ),
  );

const findNextEvent = (
  repository: EventRepositoryOperations,
  cache: EventCache,
): TE.TaskEither<ServiceError, Event | null> =>
  pipe(
    cache.getNextEvent(),
    TE.mapLeft((error) =>
      createServiceIntegrationError({
        message: 'Failed to fetch next event from cache',
        cause: error,
      }),
    ),
    TE.chain((cached) =>
      cached
        ? TE.right(cached)
        : pipe(
            repository.findNext(),
            TE.mapLeft((error) =>
              createServiceOperationError({
                message: 'Failed to fetch next event from repository',
                cause: error,
              }),
            ),
            TE.map((event) => (event ? toDomainEvent(event) : null)),
            TE.chain((event) =>
              event
                ? pipe(
                    cache.cacheEvent(event),
                    TE.mapLeft((error) =>
                      createServiceIntegrationError({
                        message: 'Failed to cache next event',
                        cause: error,
                      }),
                    ),
                    TE.map(() => event),
                  )
                : TE.right(null),
            ),
          ),
    ),
  );

export const createEventService = (
  bootstrapApi: BootstrapApi & { getBootstrapEvents: () => Promise<EventResponse[]> },
  repository: EventRepositoryOperations,
): EventService => {
  const cache = createEventServiceCache(bootstrapApi);

  return {
    getEvents: () => findAllEvents(repository, cache),
    getEvent: (id: EventId) => findEventById(repository, cache, id),
    getCurrentEvent: () => findCurrentEvent(repository, cache),
    getNextEvent: () => findNextEvent(repository, cache),
    saveEvents: (events: readonly Event[]) =>
      pipe(
        repository.createMany(events),
        TE.mapLeft((error) =>
          createServiceOperationError({
            message: 'Failed to save events',
            cause: error,
          }),
        ),
        TE.map((savedEvents) => savedEvents.map(toDomainEvent)),
      ),
  };
};
