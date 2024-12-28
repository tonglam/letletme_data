/**
 * Events domain operations module.
 * Provides high-level operations for managing events with caching support.
 * Follows functional programming principles using fp-ts.
 */

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  withCache,
  withCacheSingle,
  withCreate,
  withCreateBatch,
  withValidatedCache,
} from '../../infrastructure/cache/utils';
import { APIError, createValidationError } from '../../infrastructure/http/common/errors';
import {
  Event as DomainEvent,
  EventId,
  EventRepository,
  PrismaEventCreate,
  toDomainEvent,
  toPrismaEvent,
  validateEventId,
} from '../../types/events.type';
import { toAPIError } from '../../utils/domain.util';
import { type EventCache } from './cache';

// Repository operations
/**
 * Retrieves all events with caching support.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @returns TaskEither containing array of domain events or APIError
 */
export const getAllEvents = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  pipe(
    withCache(
      () => cache.getAllEvents(),
      () =>
        pipe(
          repository.findAll(),
          TE.mapLeft(toAPIError),
          TE.map((events) => events.map(toDomainEvent)),
        ),
      (events) => cache.cacheEvents(events),
    ),
    TE.mapLeft(toAPIError),
  );

/**
 * Retrieves a single event by ID with caching support.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @param id - Event identifier
 * @returns TaskEither containing optional domain event or APIError
 */
export const getEventById = (
  repository: EventRepository,
  cache: EventCache,
  id: string,
): TE.TaskEither<APIError, DomainEvent | null> =>
  pipe(
    withValidatedCache(
      (id: string) => validateEventId(Number(id)),
      (validId) => cache.getEvent(String(validId)),
      (validId) =>
        pipe(
          repository.findById(validId),
          TE.mapLeft(toAPIError),
          TE.map((event) => (event ? toDomainEvent(event) : null)),
        ),
      (event) => cache.cacheEvent(event),
    )(id),
    TE.mapLeft(toAPIError),
  );

/**
 * Retrieves the current active event with caching support.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @returns TaskEither containing optional domain event or APIError
 */
export const getCurrentEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, DomainEvent | null> =>
  pipe(
    withCacheSingle(
      () => cache.getCurrentEvent(),
      () =>
        pipe(
          repository.findCurrent(),
          TE.mapLeft(toAPIError),
          TE.map((event) => (event ? toDomainEvent(event) : null)),
        ),
      (event) => cache.cacheEvent(event),
    ),
    TE.mapLeft(toAPIError),
  );

/**
 * Retrieves the next scheduled event with caching support.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @returns TaskEither containing optional domain event or APIError
 */
export const getNextEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, DomainEvent | null> =>
  pipe(
    withCacheSingle(
      () => cache.getNextEvent(),
      () =>
        pipe(
          repository.findNext(),
          TE.mapLeft(toAPIError),
          TE.map((event) => (event ? toDomainEvent(event) : null)),
        ),
      (event) => cache.cacheEvent(event),
    ),
    TE.mapLeft(toAPIError),
  );

/**
 * Creates a new event and updates cache.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @param event - Event data to create
 * @returns TaskEither containing created domain event or APIError
 */
export const createEvent = (
  repository: EventRepository,
  cache: EventCache,
  event: PrismaEventCreate,
): TE.TaskEither<APIError, DomainEvent> =>
  pipe(
    withCreate(
      () => pipe(repository.save(event), TE.mapLeft(toAPIError), TE.map(toDomainEvent)),
      (savedEvent) => cache.cacheEvent(savedEvent),
    ),
    TE.mapLeft(toAPIError),
  );

/**
 * Creates multiple events in batch and updates cache.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @param events - Array of event data to create
 * @returns TaskEither containing array of created domain events or APIError
 */
export const createEvents = (
  repository: EventRepository,
  cache: EventCache,
  events: PrismaEventCreate[],
): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  pipe(
    withCreateBatch(
      () =>
        pipe(
          repository.saveBatch(events),
          TE.mapLeft(toAPIError),
          TE.map((events) => events.map(toDomainEvent)),
        ),
      (savedEvents) => cache.cacheEvents(savedEvents),
    ),
    TE.mapLeft(toAPIError),
  );

/**
 * Deletes all events and clears cache.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @returns TaskEither containing void or APIError
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

// Domain operations
/**
 * Domain operation to find all events.
 * Provides a domain-specific interface for retrieving all events.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @returns TaskEither containing array of domain events or APIError
 */
export const findAllEvents = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, readonly DomainEvent[]> => getAllEvents(repository, cache);

/**
 * Domain operation to find event by ID.
 * Provides a domain-specific interface for retrieving a single event.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @param id - Event identifier
 * @returns TaskEither containing optional domain event or APIError
 */
export const findEventById = (
  repository: EventRepository,
  cache: EventCache,
  id: EventId,
): TE.TaskEither<APIError, DomainEvent | null> => getEventById(repository, cache, String(id));

/**
 * Domain operation to find current active event.
 * Provides a domain-specific interface for retrieving current event.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @returns TaskEither containing optional domain event or APIError
 */
export const findCurrentEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, DomainEvent | null> => getCurrentEvent(repository, cache);

/**
 * Domain operation to find next scheduled event.
 * Provides a domain-specific interface for retrieving next event.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @returns TaskEither containing optional domain event or APIError
 */
export const findNextEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, DomainEvent | null> => getNextEvent(repository, cache);

/**
 * Domain operation to save a single event.
 * Provides a domain-specific interface for creating an event.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @param event - Domain event to save
 * @returns TaskEither containing saved domain event or APIError
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
 * Domain operation to save multiple events in batch.
 * Provides a domain-specific interface for creating multiple events.
 * @param repository - Event repository instance
 * @param cache - Event cache instance
 * @param events - Array of domain events to save
 * @returns TaskEither containing array of saved domain events or APIError
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
