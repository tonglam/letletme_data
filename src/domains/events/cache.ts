/**
 * Event Cache Module
 *
 * Provides caching functionality for FPL events using Redis as the cache store.
 * Implements Cache-Aside pattern for efficient data access and reduced database load.
 *
 * Features:
 * - Type-safe event caching using Redis Hash
 * - Automatic JSON serialization/deserialization
 * - Season-based cache segmentation
 * - Functional programming approach using fp-ts
 * - Cache-aside pattern implementation
 * - Automatic cache invalidation handling
 *
 * The module uses TaskEither for error handling and functional composition,
 * ensuring type-safety and predictable error states throughout the caching layer.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../config/cache/cache.config';
import { type RedisCache } from '../../infrastructure/cache/redis';
import { CacheError, CacheErrorType } from '../../infrastructure/cache/types';
import { withCache, withCacheSingle } from '../../infrastructure/cache/utils';
import { getCurrentSeason } from '../../types/base.type';
import { type Event } from '../../types/events.type';

/**
 * Data provider interface for fetching event data.
 * Abstracts the underlying data source for the cache layer.
 */
export interface EventDataProvider {
  /** Retrieves a single event by ID */
  readonly getOne: (id: string) => Promise<Event | null>;
  /** Retrieves all events for the current season */
  readonly getAll: () => Promise<readonly Event[]>;
  /** Retrieves the current active event */
  readonly getCurrentEvent: () => Promise<Event | null>;
  /** Retrieves the next scheduled event */
  readonly getNextEvent: () => Promise<Event | null>;
}

/**
 * Configuration for event cache.
 * Defines cache behavior and segmentation parameters.
 */
export interface EventCacheConfig {
  /** Redis key prefix for event cache namespace */
  keyPrefix: string;
  /** FPL season identifier for cache segmentation */
  season: string;
}

/**
 * Event cache interface providing access to cached event data.
 * Implements Cache-Aside pattern with automatic cache population.
 */
export interface EventCache {
  /**
   * Caches a single event.
   * @param event - The event to cache
   * @returns TaskEither indicating success or CacheError
   */
  readonly cacheEvent: (event: Event) => TE.TaskEither<CacheError, void>;

  /**
   * Retrieves a cached event by ID.
   * Falls back to data provider if not in cache.
   * @param id - Event identifier
   * @returns TaskEither with event or null if not found
   */
  readonly getEvent: (id: string) => TE.TaskEither<CacheError, Event | null>;

  /**
   * Caches multiple events atomically.
   * @param events - Array of events to cache
   * @returns TaskEither indicating success or CacheError
   */
  readonly cacheEvents: (events: readonly Event[]) => TE.TaskEither<CacheError, void>;

  /**
   * Retrieves all cached events for the current season.
   * Falls back to data provider if cache is empty.
   * @returns TaskEither with array of events
   */
  readonly getAllEvents: () => TE.TaskEither<CacheError, readonly Event[]>;

  /**
   * Retrieves the current event from cache.
   * Falls back to data provider if not in cache.
   * @returns TaskEither with current event or null
   */
  readonly getCurrentEvent: () => TE.TaskEither<CacheError, Event | null>;

  /**
   * Retrieves the next event from cache.
   * Falls back to data provider if not in cache.
   * @returns TaskEither with next event or null
   */
  readonly getNextEvent: () => TE.TaskEither<CacheError, Event | null>;

  /**
   * Warms up the cache by pre-loading all events.
   * Useful for initialization and cache priming.
   * @returns TaskEither indicating success or CacheError
   */
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
}

/**
 * Creates an event cache instance.
 * Implements the EventCache interface with Redis backing store.
 *
 * @param redis - Redis cache client for storage
 * @param dataProvider - Data provider for fetching events
 * @param config - Cache configuration options
 * @returns Configured event cache instance
 */
export const createEventCache = (
  redis: RedisCache<Event>,
  dataProvider: EventDataProvider,
  config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
  },
): EventCache => {
  /** Generates Redis key with season namespace */
  const makeKey = () => `${config.keyPrefix}::${config.season}`;
  /** Key for storing current event ID */
  const makeCurrentKey = () => `${makeKey()}::current`;
  /** Key for storing next event ID */
  const makeNextKey = () => `${makeKey()}::next`;

  const cacheEvent = (event: Event): TE.TaskEither<CacheError, void> =>
    redis.hSet(makeKey(), event.id.toString(), event);

  const cacheEvents = (events: readonly Event[]): TE.TaskEither<CacheError, void> =>
    pipe(
      events,
      TE.traverseArray((event) => cacheEvent(event)),
      TE.map(() => undefined),
    );

  const getEvent = (id: string): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      withCacheSingle(
        () => redis.hGet(makeKey(), id),
        () =>
          TE.tryCatch(
            () => dataProvider.getOne(id),
            (error): CacheError => ({
              type: CacheErrorType.OPERATION,
              message: String(error),
            }),
          ),
        cacheEvent,
      ),
      TE.mapLeft((error) => ({
        type: CacheErrorType.OPERATION,
        message: error.message,
        cause: error,
      })),
    );

  const getAllEvents = (): TE.TaskEither<CacheError, readonly Event[]> =>
    pipe(
      withCache(
        () =>
          pipe(
            redis.hGetAll(makeKey()),
            TE.map((events) => Object.values(events)),
          ),
        () =>
          TE.tryCatch(
            () => dataProvider.getAll(),
            (error): CacheError => ({
              type: CacheErrorType.OPERATION,
              message: String(error),
            }),
          ),
        cacheEvents,
      ),
      TE.mapLeft((error) => ({
        type: CacheErrorType.OPERATION,
        message: error.message,
        cause: error,
      })),
    );

  const getCurrentEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      withCacheSingle(
        () => redis.get(makeCurrentKey()),
        () =>
          TE.tryCatch(
            () => dataProvider.getCurrentEvent(),
            (error): CacheError => ({
              type: CacheErrorType.OPERATION,
              message: String(error),
            }),
          ),
        (event) =>
          pipe(
            cacheEvent(event),
            TE.chain(() => redis.set(makeCurrentKey(), event)),
          ),
      ),
      TE.mapLeft((error) => ({
        type: CacheErrorType.OPERATION,
        message: error.message,
        cause: error,
      })),
    );

  const getNextEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      withCacheSingle(
        () => redis.get(makeNextKey()),
        () =>
          TE.tryCatch(
            () => dataProvider.getNextEvent(),
            (error): CacheError => ({
              type: CacheErrorType.OPERATION,
              message: String(error),
            }),
          ),
        (event) =>
          pipe(
            cacheEvent(event),
            TE.chain(() => redis.set(makeNextKey(), event)),
          ),
      ),
      TE.mapLeft((error) => ({
        type: CacheErrorType.OPERATION,
        message: error.message,
        cause: error,
      })),
    );

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => dataProvider.getAll(),
        (error): CacheError => ({
          type: CacheErrorType.OPERATION,
          message: String(error),
        }),
      ),
      TE.chain((events) => cacheEvents(events)),
    );

  return {
    cacheEvent,
    getEvent,
    cacheEvents,
    getAllEvents,
    getCurrentEvent,
    getNextEvent,
    warmUp,
  };
};
