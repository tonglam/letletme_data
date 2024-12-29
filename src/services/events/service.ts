/**
 * Event Service Implementation Module
 *
 * Implements the core event service functionality with caching and data persistence.
 * Provides high-level operations for event management in the FPL system,
 * ensuring data consistency across cache and database layers.
 *
 * @module EventService
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
 *
 * @interface EventServiceDependencies
 */
export interface EventServiceDependencies {
  /** Bootstrap API client for fetching FPL data */
  readonly bootstrapApi: BootstrapApi;
  /** Event cache for optimized data access */
  readonly eventCache: EventCache;
  /** Event repository for data persistence */
  readonly eventRepository: EventRepository;
}

/**
 * Creates an event service implementation.
 *
 * @param {EventServiceDependencies} dependencies - Required service dependencies
 * @returns {EventService} Event service instance
 */
export const createEventServiceImpl = ({
  bootstrapApi,
  eventCache,
  eventRepository,
}: EventServiceDependencies): EventService => {
  /**
   * Warms up the event cache.
   * @returns {TaskEither<APIError, void>} Success or error
   */
  const warmUp = (): TE.TaskEither<APIError, void> =>
    pipe(
      eventCache.warmUp(),
      TE.mapLeft((error) =>
        createValidationError({ message: 'Cache warm-up failed', details: { error } }),
      ),
    );

  /**
   * Retrieves all events from the system.
   * @returns {TaskEither<APIError, readonly Event[]>} Array of events or error
   */
  const getEvents = (): TE.TaskEither<APIError, readonly Event[]> =>
    findAllEvents(eventRepository, eventCache);

  /**
   * Retrieves a specific event by ID.
   * @param {EventId} id - Event identifier
   * @returns {TaskEither<APIError, Event | null>} Event if found or error
   */
  const getEvent = (id: EventId): TE.TaskEither<APIError, Event | null> =>
    findEventById(eventRepository, eventCache, id);

  /**
   * Retrieves the current active event.
   * @returns {TaskEither<APIError, Event | null>} Current event or error
   */
  const getCurrentEvent = (): TE.TaskEither<APIError, Event | null> =>
    findCurrentEvent(eventRepository, eventCache);

  /**
   * Retrieves the next scheduled event.
   * @returns {TaskEither<APIError, Event | null>} Next event or error
   */
  const getNextEvent = (): TE.TaskEither<APIError, Event | null> =>
    findNextEvent(eventRepository, eventCache);

  /**
   * Fetches fresh event data from FPL API.
   * @returns {TaskEither<APIError, readonly Event[]>} Array of events or error
   */
  const fetchFromApi = (): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      TE.tryCatch(
        () => bootstrapApi.getBootstrapData(),
        (error) =>
          createValidationError({ message: 'Failed to fetch from API', details: { error } }),
      ),
      TE.map((response) => response.events.map(toDomainEvent)),
    );

  /**
   * Validates and transforms event data.
   * @param {readonly Event[]} events - Events to validate
   * @returns {TaskEither<APIError, readonly Event[]>} Validated events or error
   */
  const validateAndTransform = (
    events: readonly Event[],
  ): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      events,
      TE.right,
      TE.chain((events) =>
        events.length > 0
          ? TE.right(events)
          : TE.left(createValidationError({ message: 'No events to process' })),
      ),
    );

  /**
   * Saves events to database.
   * @param {readonly Event[]} events - Events to save
   * @returns {TaskEither<APIError, readonly Event[]>} Saved events or error
   */
  const saveToDb = (events: readonly Event[]): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      deleteAllEvents(eventRepository, eventCache),
      TE.chain(() => saveBatchEvents(eventRepository, eventCache, events)),
    );

  /**
   * Updates the cache with new event data.
   * @param {readonly Event[]} events - Events to cache
   * @returns {TaskEither<APIError, readonly Event[]>} Cached events or error
   */
  const updateCache = (events: readonly Event[]): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      eventCache.cacheEvents(events),
      TE.mapLeft((error) =>
        createValidationError({ message: 'Failed to update cache', details: { error } }),
      ),
      TE.map(() => events),
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
