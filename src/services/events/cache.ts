// Event Service Cache Module
//
// Provides service-level caching functionality for FPL events using Redis.
// Implements adapter pattern to connect bootstrap API with domain cache,
// ensuring data consistency and proper error handling throughout the caching layer.

import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import { CachePrefix, DefaultTTL } from '../../configs/cache/cache.config';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import { createEventCache } from '../../domains/events/cache';
import {
  type EventCache,
  type EventCacheConfig,
  type EventDataProvider,
} from '../../domains/events/types';
import { createRedisCache } from '../../infrastructures/cache/redis';
import { getCurrentSeason } from '../../types/base.type';
import type { BootStrapResponse } from '../../types/bootstrap.type';
import { ServiceError } from '../../types/errors.type';
import { toDomainEvent, type Event, type EventId } from '../../types/events.type';
import { createServiceIntegrationError } from '../../utils/error.util';
import { toNullable } from '../utils';

const createEventDataProvider = (
  bootstrapApi: BootstrapApi & { getBootstrapEvents: () => Promise<BootStrapResponse['events']> },
): EventDataProvider => {
  // Core operation to fetch bootstrap events
  const getBootstrapEvents: TE.TaskEither<ServiceError, BootStrapResponse['events']> = TE.tryCatch(
    () => bootstrapApi.getBootstrapEvents(),
    (error) =>
      createServiceIntegrationError({
        message: 'Failed to fetch bootstrap events',
        cause: error instanceof Error ? error : new Error(String(error)),
      }),
  );

  // Helper function to find events by predicate
  const findEvent = (predicate: (event: BootStrapResponse['events'][number]) => boolean) =>
    flow(A.findFirst(predicate), O.map(toDomainEvent));

  // Processes bootstrap events with error handling
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
    getOne: (id: EventId) =>
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

// Creates an event cache instance for the service layer
export const createEventServiceCache = (
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

  return createEventCache(redis, dataProvider, config);
};
