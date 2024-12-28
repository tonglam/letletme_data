/**
 * Event Service Types Module
 *
 * Defines the core types and interfaces for the event service layer.
 * Provides type definitions for service operations and dependencies.
 *
 * Features:
 * - Type-safe service interface
 * - Functional error handling with TaskEither
 * - Clear dependency specifications
 * - Comprehensive operation contracts
 *
 * This module ensures type safety and clear contracts between
 * the service layer and its consumers.
 */

import type * as TE from 'fp-ts/TaskEither';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { EventCache } from '../../domains/events/cache';
import type { APIError } from '../../infrastructure/http/common/errors';
import type { Event, EventId, EventRepository } from '../../types/events.type';

/**
 * Event Service Interface
 * Provides high-level operations for event management.
 * All operations use TaskEither for functional error handling.
 */
export interface EventService {
  /**
   * Warms up the event cache.
   * Ensures optimal performance for subsequent operations.
   *
   * @returns TaskEither indicating success or failure
   */
  readonly warmUp: () => TE.TaskEither<APIError, void>;

  /**
   * Retrieves all events from the system.
   * Uses cache with database fallback.
   *
   * @returns TaskEither with array of events or error
   */
  readonly getEvents: () => TE.TaskEither<APIError, readonly Event[]>;

  /**
   * Retrieves a specific event by ID.
   * Uses cache with database fallback.
   *
   * @param id - Event identifier
   * @returns TaskEither with event or null if not found
   */
  readonly getEvent: (id: EventId) => TE.TaskEither<APIError, Event | null>;

  /**
   * Retrieves the current active event.
   * Uses cache with database fallback.
   *
   * @returns TaskEither with current event or null
   */
  readonly getCurrentEvent: () => TE.TaskEither<APIError, Event | null>;

  /**
   * Retrieves the next scheduled event.
   * Uses cache with database fallback.
   *
   * @returns TaskEither with next event or null
   */
  readonly getNextEvent: () => TE.TaskEither<APIError, Event | null>;

  /**
   * Fetches fresh event data from FPL API.
   * Transforms API response to domain events.
   *
   * @returns TaskEither with array of events from API
   */
  readonly fetchFromApi: () => TE.TaskEither<APIError, readonly Event[]>;

  /**
   * Validates and transforms event data.
   * Ensures data integrity and type safety.
   *
   * @param events - Events to validate and transform
   * @returns TaskEither with validated events or error
   */
  readonly validateAndTransform: (
    events: readonly Event[],
  ) => TE.TaskEither<APIError, readonly Event[]>;

  /**
   * Saves events to database.
   * Performs atomic operation, clearing existing data first.
   *
   * @param events - Events to save
   * @returns TaskEither with saved events or error
   */
  readonly saveToDb: (events: readonly Event[]) => TE.TaskEither<APIError, readonly Event[]>;

  /**
   * Updates the cache with new event data.
   * Ensures cache consistency after database updates.
   *
   * @param events - Events to cache
   * @returns TaskEither with cached events or error
   */
  readonly updateCache: (events: readonly Event[]) => TE.TaskEither<APIError, readonly Event[]>;
}

/**
 * Dependencies required by the Event Service implementation.
 * Follows dependency injection pattern for better testability.
 */
export interface EventServiceDependencies {
  /** Bootstrap API client for fetching FPL data */
  readonly bootstrapApi: BootstrapApi;
  /** Event cache for optimized data access */
  readonly eventCache: EventCache;
  /** Event repository for data persistence */
  readonly eventRepository: EventRepository;
}
