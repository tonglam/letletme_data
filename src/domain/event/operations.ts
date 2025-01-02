/**
 * Events domain operations module.
 * Provides high-level operations for managing events with caching support.
 * Follows functional programming principles using fp-ts.
 *
 * @module EventOperations
 */

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  withCache,
  withCacheSingle,
  withCreate,
  withCreateBatch,
} from '../../infrastructure/cache/operations';
import { DomainErrorCode } from '../../types/errors.type';
import { Event as DomainEvent, EventId, toDomainEvent } from '../../types/events.type';
import { createSafeCacheOperation, createStandardDomainError } from '../utils';
import { EventCache, EventOperations, EventRepositoryOperations } from './types';

/**
 * Creates event operations instance.
 * Implements high-level domain operations with caching support.
 */
export const createEventOperations = (
  repository: EventRepositoryOperations,
  cache: EventCache,
): EventOperations => {
  const safeCacheEvent = createSafeCacheOperation(cache.cacheEvent);

  return {
    getAllEvents: () =>
      withCache(
        () => cache.getAllEvents(),
        () =>
          pipe(
            repository.findAll(),
            TE.mapLeft((error) =>
              createStandardDomainError({
                code: DomainErrorCode.VALIDATION_ERROR,
                message: 'Failed to fetch all events',
                details: error,
              }),
            ),
            TE.map((events) => events.map(toDomainEvent)),
          ),
        (events) => cache.cacheEvents(events),
      ),

    getEventById: (id: EventId) =>
      pipe(
        cache.getEvent(String(Number(id))),
        TE.mapLeft((error) =>
          createStandardDomainError({
            code: DomainErrorCode.VALIDATION_ERROR,
            message: `Failed to fetch event ${id}`,
            details: error,
          }),
        ),
        TE.chain((cached) =>
          cached
            ? TE.right(cached)
            : pipe(
                repository.findById(id),
                TE.mapLeft((error) =>
                  createStandardDomainError({
                    code: DomainErrorCode.VALIDATION_ERROR,
                    message: `Failed to fetch event ${id} from repository`,
                    details: error,
                  }),
                ),
                TE.map((event) => (event ? toDomainEvent(event) : null)),
                TE.chain((event) =>
                  event
                    ? pipe(
                        cache.cacheEvent(event),
                        TE.mapLeft((error) =>
                          createStandardDomainError({
                            code: DomainErrorCode.VALIDATION_ERROR,
                            message: `Failed to cache event ${id}`,
                            details: error,
                          }),
                        ),
                        TE.map(() => event),
                      )
                    : TE.right(null),
                ),
              ),
        ),
      ),

    getCurrentEvent: () =>
      withCacheSingle(
        () => cache.getCurrentEvent(),
        () =>
          pipe(
            repository.findCurrent(),
            TE.mapLeft((error) =>
              createStandardDomainError({
                code: DomainErrorCode.VALIDATION_ERROR,
                message: 'Failed to fetch current event',
                details: error,
              }),
            ),
            TE.map((event) => (event ? toDomainEvent(event) : null)),
          ),
        (event) => safeCacheEvent(event),
      ),

    getNextEvent: () =>
      withCacheSingle(
        () => cache.getNextEvent(),
        () =>
          pipe(
            repository.findNext(),
            TE.mapLeft((error) =>
              createStandardDomainError({
                code: DomainErrorCode.VALIDATION_ERROR,
                message: 'Failed to fetch next event',
                details: error,
              }),
            ),
            TE.map((event) => (event ? toDomainEvent(event) : null)),
          ),
        (event) => safeCacheEvent(event),
      ),

    createEvent: (event: DomainEvent) =>
      withCreate(
        () =>
          pipe(
            repository.create(event),
            TE.mapLeft((error) =>
              createStandardDomainError({
                code: DomainErrorCode.VALIDATION_ERROR,
                message: 'Failed to create event',
                details: error,
              }),
            ),
            TE.map(toDomainEvent),
          ),
        (savedEvent) => cache.cacheEvent(savedEvent),
      ),

    createEvents: (events: readonly DomainEvent[]) =>
      withCreateBatch(
        () =>
          pipe(
            repository.createMany(events),
            TE.mapLeft((error) =>
              createStandardDomainError({
                code: DomainErrorCode.VALIDATION_ERROR,
                message: 'Failed to create events',
                details: error,
              }),
            ),
            TE.map((events) => events.map(toDomainEvent)),
          ),
        (savedEvents) => cache.cacheEvents(savedEvents),
      ),
  };
};
