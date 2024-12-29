/**
 * Events domain operations module.
 * Provides high-level operations for managing events with caching support.
 * Follows functional programming principles using fp-ts.
 *
 * @module EventOperations
 */

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { CacheError } from 'src/infrastructure/cache/types';
import {
  withCache,
  withCacheSingle,
  withCreate,
  withCreateBatch,
  withValidatedCache,
} from 'src/infrastructure/cache/utils';
import {
  Event as DomainEvent,
  EventId,
  EventRepository,
  PrismaEventCreate,
  toDomainEvent,
  toPrismaEvent,
  validateEventId,
} from '../../types/domain/events.type';
import { APIError, createValidationError } from '../../types/errors.type';
import { toAPIError } from '../../utils/domain.util';
import { type EventCache } from './cache';

/**
 * Safely caches an event, handling null values
 */
const safeCacheEvent = (
  cache: EventCache,
  event: DomainEvent | null,
): TE.TaskEither<CacheError, void> => (event ? cache.cacheEvent(event) : TE.right(undefined));

/**
 * Retrieves all events with caching support.
 * Implements cache-aside pattern with automatic cache population.
 *
 * @param {EventRepository} repository - Event repository instance for database operations
 * @param {EventCache} cache - Event cache instance for caching operations
 * @returns {TaskEither<APIError, readonly DomainEvent[]>} Array of domain events or API error
 */
export const getAllEvents = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  withCache(
    () => cache.getAllEvents(),
    () =>
      pipe(
        repository.findAll(),
        TE.mapLeft(toAPIError),
        TE.map((events) => events.map(toDomainEvent)),
      ),
    (events) => cache.cacheEvents(events),
  );

/**
 * Retrieves a specific event by ID with caching support.
 * Validates event ID before processing.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @param {string} id - Event identifier
 * @returns {TaskEither<APIError, DomainEvent | null>} Event if found or null
 */
export const getEventById = (
  repository: EventRepository,
  cache: EventCache,
  id: string,
): TE.TaskEither<APIError, DomainEvent | null> =>
  withValidatedCache(
    (id) => TE.fromEither(validateEventId(Number(id))),
    (validId) => cache.getEvent(String(validId)),
    (validId) =>
      pipe(
        repository.findById(validId),
        TE.mapLeft(toAPIError),
        TE.map((event) => (event ? toDomainEvent(event) : null)),
      ),
    (event) => safeCacheEvent(cache, event),
  )(id);

/**
 * Retrieves the current active event with caching support.
 * Uses cache-aside pattern for efficient data access.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @returns {TaskEither<APIError, DomainEvent | null>} Current event if exists or null
 */
export const getCurrentEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, DomainEvent | null> =>
  withCacheSingle(
    () => cache.getCurrentEvent(),
    () =>
      pipe(
        repository.findCurrent(),
        TE.mapLeft(toAPIError),
        TE.map((event) => (event ? toDomainEvent(event) : null)),
      ),
    (event) => safeCacheEvent(cache, event),
  );

/**
 * Retrieves the next scheduled event with caching support.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @returns {TaskEither<APIError, DomainEvent | null>} Next event if exists or null
 */
export const getNextEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, DomainEvent | null> =>
  withCacheSingle(
    () => cache.getNextEvent(),
    () =>
      pipe(
        repository.findNext(),
        TE.mapLeft(toAPIError),
        TE.map((event) => (event ? toDomainEvent(event) : null)),
      ),
    (event) => safeCacheEvent(cache, event),
  );

/**
 * Creates a new event with automatic cache invalidation.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @param {PrismaEventCreate} event - Event data to create
 * @returns {TaskEither<APIError, DomainEvent>} Created event or error
 */
export const createEvent = (
  repository: EventRepository,
  cache: EventCache,
  event: PrismaEventCreate,
): TE.TaskEither<APIError, DomainEvent> =>
  withCreate(
    () => pipe(repository.save(event), TE.mapLeft(toAPIError), TE.map(toDomainEvent)),
    (savedEvent) => cache.cacheEvent(savedEvent),
  );

/**
 * Creates multiple events in a batch operation.
 * Handles cache invalidation for all affected events.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @param {PrismaEventCreate[]} events - Array of events to create
 * @returns {TaskEither<APIError, readonly DomainEvent[]>} Created events or error
 */
export const createEvents = (
  repository: EventRepository,
  cache: EventCache,
  events: PrismaEventCreate[],
): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  withCreateBatch(
    () =>
      pipe(
        repository.saveBatch(events),
        TE.mapLeft(toAPIError),
        TE.map((events) => events.map(toDomainEvent)),
      ),
    (savedEvents) => cache.cacheEvents(savedEvents),
  );

/**
 * Deletes all events and invalidates cache.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @returns {TaskEither<APIError, void>} Success or error
 */
export const deleteAllEvents = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, void> =>
  pipe(
    repository.deleteAll(),
    TE.mapLeft(toAPIError),
    TE.chain(() =>
      pipe(
        cache.cacheEvents([]), // Clear cache by setting empty array
        TE.mapLeft(toAPIError),
      ),
    ),
  );

/**
 * Alias for getAllEvents. Provides semantic clarity for find operations.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @returns {TaskEither<APIError, readonly DomainEvent[]>} Array of domain events or error
 */
export const findAllEvents = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, readonly DomainEvent[]> => getAllEvents(repository, cache);

/**
 * Alias for getEventById with type-safe EventId parameter.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @param {EventId} id - Typed event identifier
 * @returns {TaskEither<APIError, DomainEvent | null>} Event if found or null
 */
export const findEventById = (
  repository: EventRepository,
  cache: EventCache,
  id: EventId,
): TE.TaskEither<APIError, DomainEvent | null> => getEventById(repository, cache, String(id));

/**
 * Alias for getCurrentEvent. Provides semantic clarity for find operations.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @returns {TaskEither<APIError, DomainEvent | null>} Current event if exists or null
 */
export const findCurrentEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, DomainEvent | null> => getCurrentEvent(repository, cache);

/**
 * Alias for getNextEvent. Provides semantic clarity for find operations.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @returns {TaskEither<APIError, DomainEvent | null>} Next event if exists or null
 */
export const findNextEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, DomainEvent | null> => getNextEvent(repository, cache);

/**
 * Saves an existing event with cache invalidation.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @param {DomainEvent} event - Event to save
 * @returns {TaskEither<APIError, DomainEvent>} Saved event or error
 */
export const saveEvent = (
  repository: EventRepository,
  cache: EventCache,
  event: DomainEvent,
): TE.TaskEither<APIError, DomainEvent> =>
  pipe(
    createEvent(repository, cache, toPrismaEvent(event)),
    TE.chain((result) =>
      result
        ? TE.right(result)
        : TE.left(createValidationError({ message: 'Failed to save event' })),
    ),
  );

/**
 * Saves multiple events in a batch operation with cache invalidation.
 *
 * @param {EventRepository} repository - Event repository instance
 * @param {EventCache} cache - Event cache instance
 * @param {readonly DomainEvent[]} events - Events to save
 * @returns {TaskEither<APIError, readonly DomainEvent[]>} Saved events or error
 */
export const saveBatchEvents = (
  repository: EventRepository,
  cache: EventCache,
  events: readonly DomainEvent[],
): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  pipe(
    events,
    TE.of,
    TE.map((events) => events.map(toPrismaEvent)),
    TE.chain((prismaEvents) => createEvents(repository, cache, prismaEvents)),
  );
