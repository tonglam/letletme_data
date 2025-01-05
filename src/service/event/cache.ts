// Event Service Cache Module
//
// Provides service-level caching functionality for FPL events using Redis.
// Implements caching operations for event data with proper error handling.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix, DefaultTTL } from '../../config/cache/cache.config';
import { createEventCache } from '../../domain/event/cache';
import {
  type EventCache,
  type EventCacheConfig,
  type EventDataProvider,
} from '../../domain/event/types';
import { createRedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError, ServiceError } from '../../types/errors.type';
import type { Event, EventId } from '../../types/events.type';
import { createServiceIntegrationError } from '../../utils/error.util';

// Creates an event cache instance for the service layer
export const createEventServiceCache = (): EventCache => {
  const redis = createRedisCache<Event>({
    keyPrefix: CachePrefix.EVENT,
    defaultTTL: DefaultTTL.EVENT,
  });

  const config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
  };

  // Null data provider since we're not using bootstrap API anymore
  const dataProvider: EventDataProvider = {
    getOne: async () => null,
    getAll: async () => [],
    getCurrentEvent: async () => null,
    getNextEvent: async () => null,
  };

  return createEventCache(redis, dataProvider, config);
};

// Cache operations for event service
export const eventCacheOperations = (cache: EventCache) => {
  const clearEventCache = (eventId?: EventId): TE.TaskEither<ServiceError, void> => {
    const mapError = (error: CacheError) =>
      createServiceIntegrationError({
        message: eventId
          ? `Failed to clear cache for event ${eventId}`
          : 'Failed to clear event cache',
        cause: error,
      });

    return eventId
      ? pipe(
          cache.getEvent(String(eventId)),
          TE.mapLeft(mapError),
          TE.map(() => undefined),
        )
      : pipe(
          cache.getAllEvents(),
          TE.mapLeft(mapError),
          TE.map(() => undefined),
        );
  };

  const cacheEvent = (event: Event): TE.TaskEither<ServiceError, void> =>
    pipe(
      cache.cacheEvent(event),
      TE.mapLeft((error) =>
        createServiceIntegrationError({
          message: `Failed to cache event ${event.id}`,
          cause: error,
        }),
      ),
    );

  const cacheEvents = (events: readonly Event[]): TE.TaskEither<ServiceError, void> =>
    pipe(
      cache.cacheEvents(events),
      TE.mapLeft((error) =>
        createServiceIntegrationError({
          message: 'Failed to cache events',
          cause: error,
        }),
      ),
    );

  return {
    clearEventCache,
    cacheEvent,
    cacheEvents,
  } as const;
};

export type EventCacheOperations = ReturnType<typeof eventCacheOperations>;
