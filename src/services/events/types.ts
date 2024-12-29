/**
 * Event Service Types Module
 *
 * Defines the core types and interfaces for the event service layer.
 * Provides type definitions for service operations and dependencies,
 * ensuring type safety and clear contracts between the service layer and its consumers.
 *
 * @module EventServiceTypes
 */

import type * as TE from 'fp-ts/TaskEither';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { EventCache } from '../../domains/events/cache';
import type { APIError } from '../../infrastructure/http/common/errors';
import type { Event, EventId, EventRepository } from '../../types/events.type';

/**
 * Event Service Interface
 * Provides high-level operations for event management.
 *
 * @interface EventService
 */
export interface EventService {
  /**
   * Warms up the event cache.
   * @returns {TaskEither<APIError, void>} Success or error
   */
  readonly warmUp: () => TE.TaskEither<APIError, void>;

  /**
   * Retrieves all events from the system.
   * @returns {TaskEither<APIError, readonly Event[]>} Array of events or error
   */
  readonly getEvents: () => TE.TaskEither<APIError, readonly Event[]>;

  /**
   * Retrieves a specific event by ID.
   * @param {EventId} id - Event identifier
   * @returns {TaskEither<APIError, Event | null>} Event if found or error
   */
  readonly getEvent: (id: EventId) => TE.TaskEither<APIError, Event | null>;

  /**
   * Retrieves the current active event.
   * @returns {TaskEither<APIError, Event | null>} Current event or error
   */
  readonly getCurrentEvent: () => TE.TaskEither<APIError, Event | null>;

  /**
   * Retrieves the next scheduled event.
   * @returns {TaskEither<APIError, Event | null>} Next event or error
   */
  readonly getNextEvent: () => TE.TaskEither<APIError, Event | null>;

  /**
   * Fetches fresh event data from FPL API.
   * @returns {TaskEither<APIError, readonly Event[]>} Array of events or error
   */
  readonly fetchFromApi: () => TE.TaskEither<APIError, readonly Event[]>;

  /**
   * Validates and transforms event data.
   * @param {readonly Event[]} events - Events to validate
   * @returns {TaskEither<APIError, readonly Event[]>} Validated events or error
   */
  readonly validateAndTransform: (
    events: readonly Event[],
  ) => TE.TaskEither<APIError, readonly Event[]>;

  /**
   * Saves events to database.
   * @param {readonly Event[]} events - Events to save
   * @returns {TaskEither<APIError, readonly Event[]>} Saved events or error
   */
  readonly saveToDb: (events: readonly Event[]) => TE.TaskEither<APIError, readonly Event[]>;

  /**
   * Updates the cache with new event data.
   * @param {readonly Event[]} events - Events to cache
   * @returns {TaskEither<APIError, readonly Event[]>} Cached events or error
   */
  readonly updateCache: (events: readonly Event[]) => TE.TaskEither<APIError, readonly Event[]>;
}

/**
 * Required dependencies for event service.
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
