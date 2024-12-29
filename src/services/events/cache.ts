/**
 * Event Service Cache Module
 *
 * Provides service-level caching functionality for FPL events using Redis.
 * Implements adapter pattern to connect bootstrap API with domain cache,
 * ensuring data consistency and proper error handling throughout the caching layer.
 *
 * @module EventServiceCache
 */

import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import { CachePrefix, DefaultTTL } from '../../config/cache/cache.config';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import {
  createEventCache as createDomainEventCache,
  type EventCache,
  type EventCacheConfig,
  type EventDataProvider,
} from '../../domains/events/cache';
import { createRedisCache } from '../../infrastructure/cache/redis';
import { CacheError, CacheErrorType } from '../../infrastructure/cache/types';
import { getCurrentSeason } from '../../types/base.type';
import type { BootStrapResponse } from '../../types/bootstrap.type';
import { toDomainEvent, type Event } from '../../types/domain/events.type';
import { toNullable } from '../../utils/service.util';

/**
 * Creates an event data provider using the Bootstrap API.
 *
 * @param {BootstrapApi & { getBootstrapEvents: () => Promise<BootStrapResponse['events']> }} bootstrapApi - Bootstrap API client
 * @returns {EventDataProvider} Event data provider instance
 */
const createEventDataProvider = (
  bootstrapApi: BootstrapApi & { getBootstrapEvents: () => Promise<BootStrapResponse['events']> },
): EventDataProvider => {
  /**
   * Core operation to fetch bootstrap events.
   * @returns {TaskEither<CacheError, BootStrapResponse['events']>} Bootstrap events or error
   */
  const getBootstrapEvents: TE.TaskEither<CacheError, BootStrapResponse['events']> = TE.tryCatch(
    () => bootstrapApi.getBootstrapEvents(),
    (error): CacheError => ({
      type: CacheErrorType.OPERATION,
      message: 'Failed to fetch bootstrap events',
      cause: error,
    }),
  );

  /**
   * Helper function to find events by predicate.
   * @param {(event: BootStrapResponse['events'][number]) => boolean} predicate - Event filter
   * @returns {(events: BootStrapResponse['events']) => Option<Event>} Event finder function
   */
  const findEvent = (predicate: (event: BootStrapResponse['events'][number]) => boolean) =>
    flow(A.findFirst(predicate), O.map(toDomainEvent));

  /**
   * Processes bootstrap events with error handling.
   * @template T Result type
   * @param {(events: BootStrapResponse['events']) => Option<T>} transform - Event transformer
   * @param {T} defaultValue - Fallback value
   * @returns {Promise<T>} Processed result or default value
   */
  const processBootstrapEvents = <T>(
    transform: (events: BootStrapResponse['events']) => O.Option<T>,
    defaultValue: T,
  ): Promise<T> =>
    pipe(
      getBootstrapEvents,
      TE.map(transform),
      TE.map(toNullable(defaultValue)),
      TE.fold((error) => {
        console.warn('Bootstrap data fetch failed:', error);
        return T.of(defaultValue);
      }, T.of),
    )();

  return {
    getOne: (id: string) =>
      processBootstrapEvents(
        findEvent((e) => e.id === Number(id)),
        null,
      ),

    getAll: () =>
      processBootstrapEvents(flow(A.map(toDomainEvent), O.some), [] as readonly Event[]),

    getCurrentEvent: () =>
      processBootstrapEvents(
        findEvent((e) => e.is_current),
        null,
      ),

    getNextEvent: () =>
      processBootstrapEvents(
        findEvent((e) => e.is_next),
        null,
      ),
  };
};

/**
 * Creates an event cache instance for the service layer.
 *
 * @param {BootstrapApi & { getBootstrapEvents: () => Promise<BootStrapResponse['events']> }} bootstrapApi - Bootstrap API client
 * @returns {EventCache} Event cache instance
 */
export const createEventCache = (
  bootstrapApi: BootstrapApi & { getBootstrapEvents: () => Promise<BootStrapResponse['events']> },
): EventCache => {
  const redis = createRedisCache<Event>({
    keyPrefix: CachePrefix.EVENT,
    defaultTTL: DefaultTTL.EVENT,
  });

  const config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
  };

  const dataProvider = createEventDataProvider(bootstrapApi);

  return createDomainEventCache(redis, dataProvider, config);
};
