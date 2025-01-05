// Event Cache Module
// Provides caching functionality for FPL events using Redis as the cache store.
// Implements Cache-Aside pattern for efficient data access and reduced database load.
// Uses TaskEither for error handling and functional composition,
// ensuring type-safety and predictable error states throughout the caching layer.

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from '../../config/cache/cache.config';
import { redisClient } from '../../infrastructure/cache/client';
import { withCacheErrorHandling } from '../../infrastructure/cache/operations';
import { type RedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError } from '../../types/errors.type';
import { type Event, type EventId } from '../../types/events.type';
import { createCacheOperationError } from '../../utils/error.util';
import { type EventCache, type EventCacheConfig, type EventDataProvider } from './types';

// Creates an event cache instance.
// Implements the EventCache interface with Redis as the backing store.
export const createEventCache = (
  redis: RedisCache<Event>,
  dataProvider: EventDataProvider,
  config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
  },
): EventCache => {
  // Generates the base cache key for the current season
  const makeKey = () => `${config.keyPrefix}::${config.season}`;

  // Generates the cache key for the current event
  const makeCurrentKey = () => `${makeKey()}::current`;

  // Generates the cache key for the next event
  const makeNextKey = () => `${makeKey()}::next`;

  // Caches a single event in Redis
  const cacheEvent = (event: Event): TE.TaskEither<CacheError, void> =>
    redis.hSet(makeKey(), event.id.toString(), event);

  // Caches multiple events atomically in Redis
  const cacheEvents = (events: readonly Event[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (events.length === 0) return;
          const key = makeKey();
          for (const event of events) {
            try {
              const serialized = JSON.stringify(event);
              await redisClient.hset(key, event.id.toString(), serialized);
            } catch (error) {
              throw createCacheOperationError({
                message: `Failed to cache event ${event.id}`,
                cause: error instanceof Error ? error : new Error(String(error)),
              });
            }
          }
        },
        (error) =>
          createCacheOperationError({
            message: 'Failed to cache multiple events',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    );

  // Retrieves a cached event by ID with fallback
  const getEvent = (id: string): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      redis.hGet(makeKey(), id),
      TE.chain((cached) =>
        cached
          ? TE.right(cached)
          : pipe(
              TE.tryCatch(
                () => dataProvider.getOne(Number(id) as EventId),
                (error) =>
                  createCacheOperationError({
                    message: `Failed to fetch event ${id} from data provider`,
                    cause: error instanceof Error ? error : new Error(String(error)),
                  }),
              ),
              TE.chain((event) =>
                event
                  ? pipe(
                      cacheEvent(event),
                      TE.bimap(
                        (error) => error,
                        () => event,
                      ),
                    )
                  : TE.right(null),
              ),
            ),
      ),
    );

  // Retrieves all cached events with fallback
  const getAllEvents = (): TE.TaskEither<CacheError, readonly Event[]> =>
    pipe(
      TE.tryCatch(
        async () => {
          const key = makeKey();
          const fields = await redisClient.hgetall(key);
          if (!fields) return [];
          return Object.entries(fields)
            .map(([, value]) => {
              try {
                return JSON.parse(value as string) as Event;
              } catch {
                return null;
              }
            })
            .filter((event): event is Event => event !== null);
        },
        (error) =>
          createCacheOperationError({
            message: 'Failed to get all events from cache',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain((cached) =>
        cached.length > 0
          ? TE.right(cached)
          : pipe(
              TE.tryCatch(
                () => dataProvider.getAll(),
                (error) =>
                  createCacheOperationError({
                    message: 'Failed to fetch all events from data provider',
                    cause: error instanceof Error ? error : new Error(String(error)),
                  }),
              ),
              TE.chain((events) =>
                pipe(
                  cacheEvents(events),
                  TE.bimap(
                    (error) => error,
                    () => events,
                  ),
                ),
              ),
            ),
      ),
    );

  // Retrieves current event with fallback
  const getCurrentEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      redis.get(makeCurrentKey()),
      TE.chain((cached) =>
        cached
          ? TE.right(cached)
          : pipe(
              TE.tryCatch(
                () => dataProvider.getCurrentEvent(),
                (error) =>
                  createCacheOperationError({
                    message: 'Failed to fetch current event from data provider',
                    cause: error instanceof Error ? error : new Error(String(error)),
                  }),
              ),
              TE.chain((event) =>
                event === null
                  ? TE.right(null)
                  : pipe(
                      redis.set(makeCurrentKey(), event),
                      TE.fold(
                        () => TE.right(event), // Still return event even if caching fails
                        () => TE.right(event),
                      ),
                    ),
              ),
              TE.mapLeft((error) => error), // Ensure API errors are properly propagated
            ),
      ),
    );

  // Retrieves next event with fallback
  const getNextEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      redis.get(makeNextKey()),
      TE.chain((cached) =>
        cached
          ? TE.right(cached)
          : pipe(
              TE.tryCatch(
                () => dataProvider.getNextEvent(),
                (error) =>
                  createCacheOperationError({
                    message: 'Failed to fetch next event from data provider',
                    cause: error instanceof Error ? error : new Error(String(error)),
                  }),
              ),
              TE.chain((event) =>
                event
                  ? pipe(
                      redis.set(makeNextKey(), event),
                      TE.bimap(
                        (error) => error,
                        () => event,
                      ),
                    )
                  : TE.right(null),
              ),
            ),
      ),
    );

  // Warms up the cache by pre-loading all events
  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      withCacheErrorHandling(() => dataProvider.getAll(), 'Failed to warm up events cache'),
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
