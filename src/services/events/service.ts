/**
 * Event Service Implementation Module
 *
 * Implements the core event service functionality with caching and data persistence.
 * Provides high-level operations for event management in the FPL system.
 *
 * Features:
 * - Integration with Bootstrap API
 * - Cache management with warm-up
 * - Data validation and transformation
 * - Error handling with fp-ts
 * - Atomic database operations
 * - Cache consistency maintenance
 *
 * The service ensures data consistency across cache and database layers
 * while providing a clean interface for event operations.
 */

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { EventCache } from '../../domains/events/cache';
import {
  deleteAllEvents,
  findAllEvents,
  findCurrentEvent,
  findEventById,
  findNextEvent,
  saveBatchEvents,
} from '../../domains/events/operations';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import type { Event, EventId, EventRepository } from '../../types/events.type';
import { toDomainEvent } from '../../types/events.type';
import type { EventService } from './types';

/**
 * Required dependencies for event service implementation.
 * Follows dependency injection pattern for better testability.
 */
export interface EventServiceDependencies {
  readonly bootstrapApi: BootstrapApi;
  readonly eventCache: EventCache;
  readonly eventRepository: EventRepository;
}

/**
 * Creates an event service implementation.
 * Implements EventService interface with provided dependencies.
 *
 * @param dependencies - Required service dependencies
 * @returns Configured event service instance
 */
export const createEventServiceImpl = ({
  bootstrapApi,
  eventCache,
  eventRepository,
}: EventServiceDependencies): EventService => {
  /**
   * Warms up the event cache.
   * Ensures cache is populated for optimal performance.
   */
  const warmUp = (): TE.TaskEither<APIError, void> =>
    pipe(
      eventCache.warmUp(),
      TE.mapLeft((error) =>
        createValidationError({ message: `Cache warm-up failed: ${error.message}` }),
      ),
    );

  /**
   * Retrieves all events from cache with database fallback.
   */
  const getEvents = (): TE.TaskEither<APIError, readonly Event[]> =>
    findAllEvents(eventRepository, eventCache);

  /**
   * Retrieves a specific event by ID from cache with database fallback.
   */
  const getEvent = (id: EventId): TE.TaskEither<APIError, Event | null> =>
    findEventById(eventRepository, eventCache, id);

  /**
   * Retrieves the current active event from cache with database fallback.
   */
  const getCurrentEvent = (): TE.TaskEither<APIError, Event | null> =>
    findCurrentEvent(eventRepository, eventCache);

  /**
   * Retrieves the next scheduled event from cache with database fallback.
   */
  const getNextEvent = (): TE.TaskEither<APIError, Event | null> =>
    findNextEvent(eventRepository, eventCache);

  /**
   * Fetches fresh event data from the FPL API.
   * Transforms API response to domain events.
   */
  const fetchFromApi = (): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      TE.tryCatch(
        () => bootstrapApi.getBootstrapData(),
        (error) =>
          createValidationError({ message: `Failed to fetch events from API: ${String(error)}` }),
      ),
      TE.map((response) => response.events.map(toDomainEvent)),
    );

  /**
   * Validates event data and ensures required fields are present.
   * Transforms data to ensure type safety.
   */
  const validateAndTransform = (
    events: readonly Event[],
  ): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      events,
      TE.right,
      TE.chain((events) =>
        events.every((event) => event.id && event.name && event.deadlineTime)
          ? TE.right(events)
          : TE.left(createValidationError({ message: 'Invalid event data received from API' })),
      ),
    );

  /**
   * Saves events to database after clearing existing data.
   * Ensures atomic operation with proper error handling.
   */
  const saveToDb = (events: readonly Event[]): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      deleteAllEvents(eventRepository, eventCache),
      TE.chain(() => saveBatchEvents(eventRepository, eventCache, events)),
      TE.mapLeft((error) =>
        createValidationError({ message: `Failed to save events to database: ${error.message}` }),
      ),
    );

  /**
   * Updates the cache with new event data.
   * Ensures cache consistency after database updates.
   */
  const updateCache = (events: readonly Event[]): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      eventCache.warmUp(),
      TE.chain(() => eventCache.cacheEvents(events)),
      TE.map(() => events),
      TE.mapLeft((error) =>
        createValidationError({ message: `Failed to update cache: ${error.message}` }),
      ),
    );

  return {
    warmUp,
    getEvents,
    getEvent,
    getCurrentEvent,
    getNextEvent,
    fetchFromApi,
    validateAndTransform,
    saveToDb,
    updateCache,
  };
};
