/**
 * Event Cache Module
 *
 * Provides caching functionality for FPL events using Redis as the cache store.
 * Implements Cache-Aside pattern for efficient data access and reduced database load.
 * Uses TaskEither for error handling and functional composition,
 * ensuring type-safety and predictable error states throughout the caching layer.
 *
 * @module EventCache
 */

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from '../../config/cache/cache.config';
import { type RedisCache } from '../../infrastructure/cache/redis';
import { CacheError, CacheErrorType } from '../../infrastructure/cache/types';
import { getCurrentSeason } from '../../types/base.type';
import { type Event } from '../../types/events.type';

/**
 * Data provider interface for fetching event data.
 * Abstracts the underlying data source for the cache layer.
 *
 * @interface EventDataProvider
 */
export interface EventDataProvider {
  /**
   * Retrieves a single event by ID
   * @param {string} id - Event identifier
   * @returns {Promise<Event | null>} Event if found or null
   */
  readonly getOne: (id: string) => Promise<Event | null>;

  /**
   * Retrieves all events for the current season
   * @returns {Promise<readonly Event[]>} Array of events
   */
  readonly getAll: () => Promise<readonly Event[]>;

  /**
   * Retrieves the current active event
   * @returns {Promise<Event | null>} Current event if exists or null
   */
  readonly getCurrentEvent: () => Promise<Event | null>;

  /**
   * Retrieves the next scheduled event
   * @returns {Promise<Event | null>} Next event if exists or null
   */
  readonly getNextEvent: () => Promise<Event | null>;
}

/**
 * Configuration for event cache.
 * Defines cache behavior and segmentation parameters.
 *
 * @interface EventCacheConfig
 */
export interface EventCacheConfig {
  /** Redis key prefix for event cache namespace */
  keyPrefix: string;
  /** FPL season identifier for cache segmentation */
  season: string;
}

/**
 * Event cache interface.
 * Provides methods for caching and retrieving event data.
 *
 * @interface EventCache
 */
export interface EventCache {
  /**
   * Caches a single event.
   * @param {Event} event - The event to cache
   * @returns {TaskEither<CacheError, void>} Success or cache error
   */
  readonly cacheEvent: (event: Event) => TE.TaskEither<CacheError, void>;

  /**
   * Retrieves a cached event by ID.
   * Falls back to data provider if not in cache.
   * @param {string} id - Event identifier
   * @returns {TaskEither<CacheError, Event | null>} Event if found or null
   */
  readonly getEvent: (id: string) => TE.TaskEither<CacheError, Event | null>;

  /**
   * Caches multiple events atomically.
   * @param {readonly Event[]} events - Array of events to cache
   * @returns {TaskEither<CacheError, void>} Success or cache error
   */
  readonly cacheEvents: (events: readonly Event[]) => TE.TaskEither<CacheError, void>;

  /**
   * Retrieves all cached events for the current season.
   * Falls back to data provider if cache is empty.
   * @returns {TaskEither<CacheError, readonly Event[]>} Array of events
   */
  readonly getAllEvents: () => TE.TaskEither<CacheError, readonly Event[]>;

  /**
   * Retrieves the current event from cache.
   * Falls back to data provider if not in cache.
   * @returns {TaskEither<CacheError, Event | null>} Current event or null
   */
  readonly getCurrentEvent: () => TE.TaskEither<CacheError, Event | null>;

  /**
   * Retrieves the next event from cache.
   * Falls back to data provider if not in cache.
   * @returns {TaskEither<CacheError, Event | null>} Next event or null
   */
  readonly getNextEvent: () => TE.TaskEither<CacheError, Event | null>;

  /**
   * Warms up the cache by pre-loading all events.
   * Useful for initialization and cache priming.
   * @returns {TaskEither<CacheError, void>} Success or cache error
   */
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
}

/**
 * Creates an event cache instance.
 * Implements the EventCache interface with Redis as the backing store.
 *
 * @param {RedisCache<Event>} redis - Redis cache client
 * @param {EventDataProvider} dataProvider - Data provider for cache misses
 * @param {EventCacheConfig} [config] - Optional cache configuration
 * @returns {EventCache} Event cache instance
 */
export const createEventCache = (
  redis: RedisCache<Event>,
  dataProvider: EventDataProvider,
  config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
  },
): EventCache => {
  /**
   * Generates the base cache key for the current season
   * @returns {string} Base cache key
   */
  const makeKey = () => `${config.keyPrefix}::${config.season}`;

  /**
   * Generates the cache key for the current event
   * @returns {string} Current event cache key
   */
  const makeCurrentKey = () => `${makeKey()}::current`;

  /**
   * Generates the cache key for the next event
   * @returns {string} Next event cache key
   */
  const makeNextKey = () => `${makeKey()}::next`;

  /**
   * Caches a single event in Redis
   * @param {Event} event - Event to cache
   * @returns {TaskEither<CacheError, void>} Success or cache error
   */
  const cacheEvent = (event: Event): TE.TaskEither<CacheError, void> =>
    redis.hSet(makeKey(), event.id.toString(), event);

  /**
   * Caches multiple events atomically in Redis
   * @param {readonly Event[]} events - Events to cache
   * @returns {TaskEither<CacheError, void>} Success or cache error
   */
  const cacheEvents = (events: readonly Event[]): TE.TaskEither<CacheError, void> =>
    pipe(
      events,
      TE.traverseArray((event) => cacheEvent(event)),
      TE.map(() => undefined),
    );

  /**
   * Retrieves a cached event by ID with fallback
   * @param {string} id - Event identifier
   * @returns {TaskEither<CacheError, Event | null>} Event if found or null
   */
  const getEvent = (id: string): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      redis.hGet(makeKey(), id),
      TE.chain((cached) =>
        cached
          ? TE.right(cached)
          : pipe(
              TE.tryCatch(
                () => dataProvider.getOne(id),
                (error) => ({
                  type: CacheErrorType.OPERATION,
                  message: String(error),
                }),
              ),
              TE.chain((event) =>
                event
                  ? pipe(
                      cacheEvent(event),
                      TE.map(() => event),
                    )
                  : TE.right(null),
              ),
            ),
      ),
    );

  /**
   * Retrieves all cached events with fallback
   * @returns {TaskEither<CacheError, readonly Event[]>} Array of events
   */
  const getAllEvents = (): TE.TaskEither<CacheError, readonly Event[]> =>
    pipe(
      redis.hGetAll(makeKey()),
      TE.map((events) => Object.values(events)),
      TE.chain((cached) =>
        cached.length > 0
          ? TE.right(cached)
          : pipe(
              TE.tryCatch(
                () => dataProvider.getAll(),
                (error) => ({
                  type: CacheErrorType.OPERATION,
                  message: String(error),
                }),
              ),
              TE.chain((events) =>
                pipe(
                  cacheEvents(events),
                  TE.map(() => events),
                ),
              ),
            ),
      ),
    );

  /**
   * Retrieves current event with fallback
   * @returns {TaskEither<CacheError, Event | null>} Current event or null
   */
  const getCurrentEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      redis.get(makeCurrentKey()),
      TE.chain((cached) =>
        cached
          ? TE.right(cached)
          : pipe(
              TE.tryCatch(
                () => dataProvider.getCurrentEvent(),
                (error) => ({
                  type: CacheErrorType.OPERATION,
                  message: String(error),
                }),
              ),
              TE.chain((event) =>
                event
                  ? pipe(
                      redis.set(makeCurrentKey(), event),
                      TE.map(() => event),
                    )
                  : TE.right(null),
              ),
            ),
      ),
    );

  /**
   * Retrieves next event with fallback
   * @returns {TaskEither<CacheError, Event | null>} Next event or null
   */
  const getNextEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      redis.get(makeNextKey()),
      TE.chain((cached) =>
        cached
          ? TE.right(cached)
          : pipe(
              TE.tryCatch(
                () => dataProvider.getNextEvent(),
                (error) => ({
                  type: CacheErrorType.OPERATION,
                  message: String(error),
                }),
              ),
              TE.chain((event) =>
                event
                  ? pipe(
                      redis.set(makeNextKey(), event),
                      TE.map(() => event),
                    )
                  : TE.right(null),
              ),
            ),
      ),
    );

  /**
   * Warms up the cache by pre-loading all events
   * @returns {TaskEither<CacheError, void>} Success or cache error
   */
  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => dataProvider.getAll(),
        (error) => ({
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
