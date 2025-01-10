/**
 * Events domain operations module.
 * Provides high-level operations for managing events with caching support.
 * Follows functional programming principles using fp-ts.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainErrorCode, createDomainError } from '../../types/error.type';
import {
  EventCache,
  EventId,
  EventOperations as EventOps,
  EventRepository,
  Events,
  toDomainEvent,
  toPrismaEvent,
} from './types';

export const createEventOperations = (
  repository: EventRepository,
  cache: EventCache,
): EventOps => ({
  getAllEvents: () =>
    pipe(
      cache.getAllEvents(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get all events: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedEvents) =>
        cachedEvents.length > 0
          ? TE.right(cachedEvents)
          : pipe(
              repository.findAll(),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch events from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((events) => events.map(toDomainEvent)),
              TE.chainFirst((events) =>
                pipe(
                  cache.cacheEvents(events),
                  TE.mapLeft((error) =>
                    createDomainError({
                      code: DomainErrorCode.CACHE_ERROR,
                      message: `Failed to cache events: ${error.message}`,
                      cause: error,
                    }),
                  ),
                ),
              ),
            ),
      ),
    ),

  getEventById: (id: EventId) =>
    pipe(
      cache.getEvent(id.toString()),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get event by id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedEvent) =>
        cachedEvent
          ? TE.right(cachedEvent)
          : pipe(
              repository.findById(id),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch event from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((event) => (event ? toDomainEvent(event) : null)),
              TE.chainFirst((event) =>
                event
                  ? pipe(
                      cache.cacheEvent(event),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Failed to cache event: ${error.message}`,
                          cause: error,
                        }),
                      ),
                    )
                  : TE.right(void 0),
              ),
            ),
      ),
    ),

  getCurrentEvent: () =>
    pipe(
      cache.getCurrentEvent(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get current event: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedEvent) =>
        cachedEvent
          ? TE.right(cachedEvent)
          : pipe(
              repository.findCurrent(),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch current event from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((event) => (event ? toDomainEvent(event) : null)),
              TE.chainFirst((event) =>
                event
                  ? pipe(
                      cache.cacheEvent(event),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Failed to cache current event: ${error.message}`,
                          cause: error,
                        }),
                      ),
                    )
                  : TE.right(void 0),
              ),
            ),
      ),
    ),

  getNextEvent: () =>
    pipe(
      cache.getNextEvent(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get next event: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedEvent) =>
        cachedEvent
          ? TE.right(cachedEvent)
          : pipe(
              repository.findNext(),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch next event from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((event) => (event ? toDomainEvent(event) : null)),
              TE.chainFirst((event) =>
                event
                  ? pipe(
                      cache.cacheEvent(event),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Failed to cache next event: ${error.message}`,
                          cause: error,
                        }),
                      ),
                    )
                  : TE.right(void 0),
              ),
            ),
      ),
    ),

  createEvents: (events: Events) =>
    pipe(
      repository.saveBatch(events.map(toPrismaEvent)),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to create events: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((savedEvents) => savedEvents.map(toDomainEvent)),
      TE.chainFirst((createdEvents) =>
        pipe(
          cache.cacheEvents(createdEvents),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Failed to cache created events: ${error.message}`,
              cause: error,
            }),
          ),
        ),
      ),
    ),

  deleteAll: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to delete all events: ${error.message}`,
          cause: error,
        }),
      ),
    ),
});
