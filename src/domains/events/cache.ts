// Event Cache Module
// Provides caching functionality for FPL events using Redis as the cache store.
// Implements Cache-Aside pattern for efficient data access and reduced database load.
// Uses TaskEither for error handling and functional composition,
// ensuring type-safety and predictable error states throughout the caching layer.

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { CacheError } from 'src/types/errors.type';
import { CachePrefix } from '../../configs/cache/cache.config';
import { withCacheErrorHandling, withPipeline } from '../../infrastructures/cache/operations';
import { type RedisCache } from '../../infrastructures/cache/redis';
import { getCurrentSeason } from '../../types/base.type';
import { type Event, type EventId } from '../../types/events.type';
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
    withPipeline(events, (pipeline, event) => {
      pipeline.hset(makeKey(), event.id.toString(), JSON.stringify(event));
    });

  // Retrieves a cached event by ID with fallback
  const getEvent = (id: string): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      redis.hGet(makeKey(), id),
      TE.chain((cached) =>
        cached
          ? TE.right(cached)
          : pipe(
              withCacheErrorHandling(
                () => dataProvider.getOne(Number(id) as EventId),
                `Failed to fetch event ${id}`,
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

  // Retrieves all cached events with fallback
  const getAllEvents = (): TE.TaskEither<CacheError, readonly Event[]> =>
    pipe(
      redis.hGetAll(makeKey()),
      TE.map((events) => Object.values(events)),
      TE.chain((cached) =>
        cached.length > 0
          ? TE.right(cached)
          : pipe(
              withCacheErrorHandling(() => dataProvider.getAll(), 'Failed to fetch all events'),
              TE.chain((events) =>
                pipe(
                  cacheEvents(events),
                  TE.map(() => events),
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
              withCacheErrorHandling(
                () => dataProvider.getCurrentEvent(),
                'Failed to fetch current event',
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

  // Retrieves next event with fallback
  const getNextEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      redis.get(makeNextKey()),
      TE.chain((cached) =>
        cached
          ? TE.right(cached)
          : pipe(
              withCacheErrorHandling(
                () => dataProvider.getNextEvent(),
                'Failed to fetch next event',
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
