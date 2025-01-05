// Event Cache Module
// Provides caching functionality for FPL events using Redis as the cache store.
// Implements Cache-Aside pattern for efficient data access and reduced database load.
// Uses TaskEither for error handling and functional composition,
// ensuring type-safety and predictable error states throughout the caching layer.

import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../config/cache/cache.config';
import { redisClient } from '../../infrastructure/cache/client';
import type { RedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError } from '../../types/errors.type';
import type { Event } from '../../types/events.type';
import { createCacheOperationError } from '../../utils/error.util';
import { EventCache, EventCacheConfig, EventDataProvider } from './types';

const createError = (message: string, cause?: unknown): CacheError =>
  createCacheOperationError({ message, cause });

export const createEventCache = (
  cache: RedisCache<Event>,
  dataProvider: EventDataProvider,
  config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
  },
): EventCache => {
  const { keyPrefix, season } = config;

  const cacheKey = `${keyPrefix}::${season}`;

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => dataProvider.getAll(),
        (error) => createError('Failed to warm up cache', error),
      ),
      TE.chain((events) => (events.length > 0 ? cacheEvents(events) : TE.right(undefined))),
    );

  const cacheEvent = (event: Event): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hset(cacheKey, event.id.toString(), JSON.stringify(event)),
        (error) => createError('Failed to cache event', error),
      ),
      TE.map(() => undefined),
    );

  const cacheEvents = (events: readonly Event[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (events.length === 0) return;
          const multi = redisClient.multi();
          events.forEach((event) => {
            multi.hset(cacheKey, event.id.toString(), JSON.stringify(event));
          });
          await multi.exec();
        },
        (error) => createError('Failed to cache events', error),
      ),
    );

  const getEvent = (id: string): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(cacheKey, id),
        (error) => createError('Failed to get event from cache', error),
      ),
      TE.chain((cachedEvent) =>
        pipe(
          O.fromNullable(cachedEvent),
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getOne(Number(id)),
                  (error) => createError('Failed to get event from provider', error),
                ),
                TE.chainFirst((event) => (event ? cacheEvent(event) : TE.right(undefined))),
              ),
            (eventStr) =>
              TE.tryCatch(
                async () => {
                  try {
                    return JSON.parse(eventStr) as Event;
                  } catch (error) {
                    return null;
                  }
                },
                (error) => createError('Failed to parse cached event', error),
              ),
          ),
        ),
      ),
    );

  const getAllEvents = (): TE.TaskEither<CacheError, readonly Event[]> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(cacheKey),
        (error) => createError('Failed to get events from cache', error),
      ),
      TE.chain((events) =>
        pipe(
          O.fromNullable(events),
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getAll(),
                  (error) => createError('Failed to get events from provider', error),
                ),
                TE.chain((events) =>
                  pipe(
                    cacheEvents(events),
                    TE.map(() => events),
                  ),
                ),
              ),
            (cachedEvents) =>
              pipe(
                TE.tryCatch(
                  async () => {
                    const validEvents = await Promise.all(
                      Object.values(cachedEvents).map(async (eventStr) => {
                        try {
                          return JSON.parse(eventStr) as Event;
                        } catch {
                          return null;
                        }
                      }),
                    );
                    const events = validEvents.filter((event): event is Event => {
                      return (
                        event !== null &&
                        typeof event === 'object' &&
                        'id' in event &&
                        typeof event.id === 'number'
                      );
                    });
                    return events.length > 0 ? events : null;
                  },
                  (error) => createError('Failed to parse cached events', error),
                ),
                TE.chain((events) =>
                  events
                    ? TE.right(events)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getAll(),
                          (error) => createError('Failed to get events from provider', error),
                        ),
                        TE.chain((events) =>
                          pipe(
                            cacheEvents(events),
                            TE.map(() => events),
                          ),
                        ),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  const getCurrentEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      TE.tryCatch(
        () => dataProvider.getCurrentEvent(),
        (error) => createError('Failed to get current event', error),
      ),
      TE.map((event) => event || null),
    );

  const getNextEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      TE.tryCatch(
        () => dataProvider.getNextEvent(),
        (error) => createError('Failed to get next event', error),
      ),
      TE.map((event) => event || null),
    );

  return {
    warmUp,
    cacheEvent,
    cacheEvents,
    getEvent,
    getAllEvents,
    getCurrentEvent,
    getNextEvent,
  };
};
