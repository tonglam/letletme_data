/**
 * Events domain operations module.
 * Provides high-level operations for managing events with caching support.
 * Follows functional programming principles using fp-ts.
 *
 * @module EventOperations
 */

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix, DefaultTTL } from '../../config/cache/cache.config';
import { createRedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { DomainErrorCode } from '../../types/error.type';
import { Event as DomainEvent, EventId, toDomainEvent } from '../../types/event.type';
import { createStandardDomainError } from '../utils';
import { createEventCache } from './cache';
import { EventOperations, EventRepositoryOperations } from './types';

/**
 * Creates event operations instance.
 * Implements high-level domain operations with caching support.
 */
export const createEventOperations = (repository: EventRepositoryOperations): EventOperations => {
  // Create cache instance
  const redis = createRedisCache<DomainEvent>({
    defaultTTL: DefaultTTL.EVENT,
  });

  const cache = createEventCache(
    redis,
    {
      getOne: async () => null,
      getAll: async () => [],
      getCurrentEvent: async () => null,
      getNextEvent: async () => null,
    },
    {
      keyPrefix: CachePrefix.EVENT,
      season: getCurrentSeason(),
    },
  );

  const handleRepositoryError = (message: string) => (error: unknown) =>
    createStandardDomainError({
      code: DomainErrorCode.VALIDATION_ERROR,
      message,
      details: error,
    });

  const mapCacheError = (message: string) => (error: unknown) =>
    createStandardDomainError({
      code: DomainErrorCode.CACHE_ERROR,
      message,
      details: error,
    });

  const withCacheErrorMapping = <T>(message: string, task: TE.TaskEither<unknown, T>) =>
    pipe(task, TE.mapLeft(mapCacheError(message)));

  const handleDomainEvent = (
    event: E.Either<string, DomainEvent>,
  ): E.Either<string, DomainEvent> => {
    if (E.isLeft(event)) {
      return E.left(`Failed to convert to domain event: ${event.left}`);
    }
    return event;
  };

  const filterValidEvents = (events: E.Either<string, DomainEvent>[]): DomainEvent[] =>
    events.filter(E.isRight).map((e) => e.right);

  return {
    getAllEvents: () =>
      pipe(
        cache.getAllEvents(),
        TE.mapLeft(mapCacheError('Failed to get events from cache')),
        TE.chain((cachedEvents) =>
          cachedEvents.length > 0
            ? TE.right(cachedEvents)
            : pipe(
                repository.findAll(),
                TE.mapLeft(handleRepositoryError('Failed to fetch all events')),
                TE.map((events) => events.map(toDomainEvent)),
                TE.map(filterValidEvents),
                TE.chainFirst((events) =>
                  withCacheErrorMapping('Failed to cache events', cache.cacheEvents(events)),
                ),
              ),
        ),
      ),

    getEventById: (id: EventId) =>
      pipe(
        cache.getEvent(String(Number(id))),
        TE.mapLeft(mapCacheError('Failed to get event from cache')),
        TE.chain((cached) =>
          cached
            ? TE.right(cached)
            : pipe(
                repository.findById(id),
                TE.mapLeft(handleRepositoryError(`Failed to fetch event ${id} from repository`)),
                TE.map((event) => (event ? toDomainEvent(event) : null)),
                TE.chain((event) =>
                  event
                    ? pipe(
                        handleDomainEvent(event),
                        E.fold(
                          (error) =>
                            TE.left(
                              createStandardDomainError({
                                code: DomainErrorCode.VALIDATION_ERROR,
                                message: error,
                              }),
                            ),
                          (validEvent) =>
                            pipe(
                              validEvent,
                              (e) => TE.right(e),
                              TE.chainFirst(() =>
                                withCacheErrorMapping(
                                  'Failed to cache event',
                                  cache.cacheEvent(validEvent),
                                ),
                              ),
                            ),
                        ),
                      )
                    : TE.right(null),
                ),
              ),
        ),
      ),

    getCurrentEvent: () =>
      pipe(
        cache.getCurrentEvent(),
        TE.mapLeft(mapCacheError('Failed to get current event from cache')),
        TE.chain((cached) =>
          cached
            ? TE.right(cached)
            : pipe(
                repository.findCurrent(),
                TE.mapLeft(handleRepositoryError('Failed to fetch current event')),
                TE.map((event) => (event ? toDomainEvent(event) : null)),
                TE.chain((event) =>
                  event
                    ? pipe(
                        handleDomainEvent(event),
                        E.fold(
                          (error) =>
                            TE.left(
                              createStandardDomainError({
                                code: DomainErrorCode.VALIDATION_ERROR,
                                message: error,
                              }),
                            ),
                          (validEvent) =>
                            pipe(
                              validEvent,
                              (e) => TE.right(e),
                              TE.chainFirst(() =>
                                withCacheErrorMapping(
                                  'Failed to cache current event',
                                  cache.cacheEvent(validEvent),
                                ),
                              ),
                            ),
                        ),
                      )
                    : TE.right(null),
                ),
              ),
        ),
      ),

    getNextEvent: () =>
      pipe(
        cache.getNextEvent(),
        TE.mapLeft(mapCacheError('Failed to get next event from cache')),
        TE.chain((cached) =>
          cached
            ? TE.right(cached)
            : pipe(
                repository.findNext(),
                TE.mapLeft(handleRepositoryError('Failed to fetch next event')),
                TE.map((event) => (event ? toDomainEvent(event) : null)),
                TE.chain((event) =>
                  event
                    ? pipe(
                        handleDomainEvent(event),
                        E.fold(
                          (error) =>
                            TE.left(
                              createStandardDomainError({
                                code: DomainErrorCode.VALIDATION_ERROR,
                                message: error,
                              }),
                            ),
                          (validEvent) =>
                            pipe(
                              validEvent,
                              (e) => TE.right(e),
                              TE.chainFirst(() =>
                                withCacheErrorMapping(
                                  'Failed to cache next event',
                                  cache.cacheEvent(validEvent),
                                ),
                              ),
                            ),
                        ),
                      )
                    : TE.right(null),
                ),
              ),
        ),
      ),

    createEvent: (event: DomainEvent) =>
      pipe(
        repository.create(event),
        TE.mapLeft(handleRepositoryError('Failed to create event')),
        TE.map(toDomainEvent),
        TE.chain((domainEvent) =>
          pipe(
            handleDomainEvent(domainEvent),
            E.fold(
              (error) =>
                TE.left(
                  createStandardDomainError({
                    code: DomainErrorCode.VALIDATION_ERROR,
                    message: error,
                  }),
                ),
              (validEvent) =>
                pipe(
                  validEvent,
                  (e) => TE.right(e),
                  TE.chainFirst(() =>
                    withCacheErrorMapping(
                      'Failed to cache created event',
                      cache.cacheEvent(validEvent),
                    ),
                  ),
                ),
            ),
          ),
        ),
      ),

    createEvents: (events: readonly DomainEvent[]) =>
      pipe(
        repository.createMany(events),
        TE.mapLeft(handleRepositoryError('Failed to create events')),
        TE.map((events) => events.map(toDomainEvent)),
        TE.map(filterValidEvents),
        TE.chainFirst((validEvents) =>
          withCacheErrorMapping('Failed to cache created events', cache.cacheEvents(validEvents)),
        ),
      ),

    deleteAll: () =>
      pipe(
        repository.deleteAll(),
        TE.mapLeft(handleRepositoryError('Failed to delete all events')),
      ),
  };
};
