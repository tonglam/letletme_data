/**
 * Events domain operations module.
 * Provides high-level operations for managing events with caching support.
 * Follows functional programming principles using fp-ts.
 *
 * @module EventOperations
 */

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { DomainErrorCode } from '../../types/errors.type';
import { Event as DomainEvent, EventId, toDomainEvent } from '../../types/events.type';
import { createStandardDomainError } from '../utils';
import { EventCache, EventOperations, EventRepositoryOperations } from './types';

/**
 * Creates event operations instance.
 * Implements high-level domain operations with caching support.
 */
export const createEventOperations = (
  repository: EventRepositoryOperations,
  cache: EventCache,
): EventOperations => {
  const handleRepositoryError = (message: string) => (error: unknown) =>
    createStandardDomainError({
      code: DomainErrorCode.VALIDATION_ERROR,
      message,
      details: error,
    });

  const mapCacheError = (message: string) => (error: unknown) =>
    createStandardDomainError({
      code: DomainErrorCode.PROCESSING_ERROR,
      message,
      details: error,
    });

  const withCacheErrorMapping = <T>(message: string, task: TE.TaskEither<unknown, T>) =>
    pipe(task, TE.mapLeft(mapCacheError(message)));

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
                TE.chainFirst((event) =>
                  event
                    ? withCacheErrorMapping('Failed to cache event', cache.cacheEvent(event))
                    : TE.right(undefined),
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
                TE.chainFirst((event) =>
                  event
                    ? withCacheErrorMapping(
                        'Failed to cache current event',
                        cache.cacheEvent(event),
                      )
                    : TE.right(undefined),
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
                TE.chainFirst((event) =>
                  event
                    ? withCacheErrorMapping('Failed to cache next event', cache.cacheEvent(event))
                    : TE.right(undefined),
                ),
              ),
        ),
      ),

    createEvent: (event: DomainEvent) =>
      pipe(
        repository.create(event),
        TE.mapLeft(handleRepositoryError('Failed to create event')),
        TE.map(toDomainEvent),
        TE.chainFirst((savedEvent) =>
          withCacheErrorMapping('Failed to cache created event', cache.cacheEvent(savedEvent)),
        ),
      ),

    createEvents: (events: readonly DomainEvent[]) =>
      pipe(
        repository.createMany(events),
        TE.mapLeft(handleRepositoryError('Failed to create events')),
        TE.map((events) => events.map(toDomainEvent)),
        TE.chainFirst((savedEvents) =>
          withCacheErrorMapping('Failed to cache created events', cache.cacheEvents(savedEvents)),
        ),
      ),
  };
};
