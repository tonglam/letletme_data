// Event Service Module
// Provides business logic for Event operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { EventCache, EventRepositoryOperations } from '../../domain/event/types';
import { Event, EventId, toDomainEvent } from '../../types/events.type';
import { createServiceIntegrationError, createServiceOperationError } from '../../utils/error.util';
import { createEventServiceCache, eventCacheOperations } from './cache';
import { EventService, EventServiceDependencies, EventServiceOperations } from './types';

// Implementation of service operations
const eventServiceOperations: EventServiceOperations = {
  findAllEvents: (repository: EventRepositoryOperations, cache: EventCache) =>
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
    ),

  findEventById: (repository: EventRepositoryOperations, cache: EventCache, id: EventId) =>
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
    ),

  findCurrentEvent: (repository: EventRepositoryOperations, cache: EventCache) =>
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
    ),

  findNextEvent: (repository: EventRepositoryOperations, cache: EventCache) =>
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
    ),

  syncEventsFromApi: (bootstrapApi, repository, cache) =>
    pipe(
      TE.tryCatch(
        () => bootstrapApi.getBootstrapEvents(),
        (error) =>
          createServiceIntegrationError({
            message: 'Failed to fetch events from API',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.map((events) => events.map(toDomainEvent)),
      TE.chain((events) =>
        pipe(
          repository.createMany(events),
          TE.mapLeft((error) =>
            createServiceOperationError({
              message: 'Failed to save events to repository',
              cause: error,
            }),
          ),
          TE.map((savedEvents) => savedEvents.map(toDomainEvent)),
          TE.chain((savedEvents) =>
            pipe(
              cache.cacheEvents(savedEvents),
              TE.mapLeft((error) =>
                createServiceIntegrationError({
                  message: 'Failed to cache events',
                  cause: error,
                }),
              ),
              TE.map(() => savedEvents),
            ),
          ),
        ),
      ),
    ),
};

export const createEventService = (
  bootstrapApi: EventServiceDependencies['bootstrapApi'],
  repository: EventRepositoryOperations,
): EventService => {
  const cache = createEventServiceCache();
  const cacheOps = eventCacheOperations(cache);
  const ops = eventServiceOperations;

  return {
    getEvents: () => ops.findAllEvents(repository, cache),
    getEvent: (id: EventId) => ops.findEventById(repository, cache, id),
    getCurrentEvent: () => ops.findCurrentEvent(repository, cache),
    getNextEvent: () => ops.findNextEvent(repository, cache),
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
        TE.chain((savedEvents) =>
          pipe(
            cacheOps.cacheEvents(savedEvents),
            TE.mapLeft((error) =>
              createServiceIntegrationError({
                message: 'Failed to cache events',
                cause: error,
              }),
            ),
            TE.map(() => savedEvents),
          ),
        ),
      ),
    syncEventsFromApi: () => ops.syncEventsFromApi(bootstrapApi, repository, cache),
  };
};
