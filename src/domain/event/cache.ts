// Event Cache Module
// Provides caching functionality for FPL events using Redis as the cache store.
// Implements Cache-Aside pattern for efficient data access and reduced database load.
// Uses TaskEither for error handling and functional composition,
// ensuring type-safety and predictable error states throughout the caching layer.

import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import { CachePrefix } from '../../config/cache/cache.config';
import { redisClient } from '../../infrastructure/cache/client';
import type { RedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError, CacheErrorCode, createCacheError } from '../../types/error.type';
import type { Event } from '../../types/event.type';
import { EventCache, EventCacheConfig, EventDataProvider } from './types';

const parseEvent = (eventStr: string): E.Either<CacheError, Event | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(eventStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse event JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as Event)
        : E.right(null),
    ),
  );

const parseEvents = (events: Record<string, string>): E.Either<CacheError, Event[]> =>
  pipe(
    Object.values(events),
    (eventStrs) =>
      eventStrs.map((str) =>
        pipe(
          parseEvent(str),
          E.getOrElse<CacheError, Event | null>(() => null),
        ),
      ),
    (parsedEvents) => parsedEvents.filter((event): event is Event => event !== null),
    (validEvents) => E.right(validEvents),
  );

export const createEventCache = (
  cache: RedisCache<Event>,
  dataProvider: EventDataProvider,
  config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
  },
): EventCache => {
  const { keyPrefix, season } = config;

  const baseKey = `${keyPrefix}::${season}`;
  const currentEventKey = `${baseKey}::current`;
  const nextEventKey = `${baseKey}::next`;

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const events = await dataProvider.getAll();
          const multi = redisClient.multi();
          multi.del(baseKey);
          multi.del(currentEventKey);
          multi.del(nextEventKey);
          await multi.exec();

          const cacheMulti = redisClient.multi();
          events.forEach((event) => {
            cacheMulti.hset(baseKey, event.id.toString(), JSON.stringify(event));
          });
          await cacheMulti.exec();

          const currentEvent = events.find((e) => e.isCurrent);
          const nextEvent = events.find((e) => e.isNext);

          if (currentEvent) {
            await redisClient.set(currentEventKey, JSON.stringify(currentEvent));
          }
          if (nextEvent) {
            await redisClient.set(nextEventKey, JSON.stringify(nextEvent));
          }
        },
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to warm up cache',
            cause: error as Error,
          }),
      ),
    );

  const cacheEvent = (event: Event): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hset(baseKey, event.id.toString(), JSON.stringify(event)),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache event',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
    );

  const cacheEvents = (events: readonly Event[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (events.length === 0) return;

          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();

          const cacheMulti = redisClient.multi();
          events.forEach((event) => {
            cacheMulti.hset(baseKey, event.id.toString(), JSON.stringify(event));
          });
          await cacheMulti.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache events',
            cause: error as Error,
          }),
      ),
    );

  const getEvent = (id: string): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, id.toString()),
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get event from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getOne(Number(id)),
                  (error: unknown) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get event from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chainFirst((event) => (event ? cacheEvent(event) : TE.right(undefined))),
              ),
            (eventStr) =>
              pipe(
                parseEvent(eventStr),
                TE.fromEither,
                TE.chain((event) =>
                  event
                    ? TE.right(event)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getOne(Number(id)),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get event from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chainFirst((event) => (event ? cacheEvent(event) : TE.right(undefined))),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  const getAllEvents = (): TE.TaskEither<CacheError, readonly Event[]> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get events from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getAll(),
                  (error: unknown) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get events from provider',
                      cause: error as Error,
                    }),
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
                parseEvents(cachedEvents),
                TE.fromEither,
                TE.chain((events) =>
                  events.length > 0
                    ? TE.right(events)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getAll(),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get events from provider',
                              cause: error as Error,
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
              ),
          ),
        ),
      ),
    );

  const getCurrentEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.get(currentEventKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get current event from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getCurrent(),
                  (error: unknown) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get current event from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chainFirst((event) =>
                  event
                    ? TE.tryCatch(
                        () => redisClient.set(currentEventKey, JSON.stringify(event)),
                        (error: unknown) =>
                          createCacheError({
                            code: CacheErrorCode.OPERATION_ERROR,
                            message: 'Failed to cache current event',
                            cause: error as Error,
                          }),
                      )
                    : TE.right(undefined),
                ),
              ),
            (eventStr) =>
              pipe(
                parseEvent(eventStr),
                TE.fromEither,
                TE.chain((event) =>
                  event
                    ? TE.right(event)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getCurrent(),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get current event from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chainFirst((event) =>
                          event
                            ? TE.tryCatch(
                                () => redisClient.set(currentEventKey, JSON.stringify(event)),
                                (error: unknown) =>
                                  createCacheError({
                                    code: CacheErrorCode.OPERATION_ERROR,
                                    message: 'Failed to cache current event',
                                    cause: error as Error,
                                  }),
                              )
                            : TE.right(undefined),
                        ),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  const getNextEvent = (): TE.TaskEither<CacheError, Event | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.get(nextEventKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get next event from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getNext(),
                  (error: unknown) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get next event from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chainFirst((event) =>
                  event
                    ? TE.tryCatch(
                        () => redisClient.set(nextEventKey, JSON.stringify(event)),
                        (error: unknown) =>
                          createCacheError({
                            code: CacheErrorCode.OPERATION_ERROR,
                            message: 'Failed to cache next event',
                            cause: error as Error,
                          }),
                      )
                    : TE.right(undefined),
                ),
              ),
            (eventStr) =>
              pipe(
                parseEvent(eventStr),
                TE.fromEither,
                TE.chain((event) =>
                  event
                    ? TE.right(event)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getNext(),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get next event from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chainFirst((event) =>
                          event
                            ? TE.tryCatch(
                                () => redisClient.set(nextEventKey, JSON.stringify(event)),
                                (error: unknown) =>
                                  createCacheError({
                                    code: CacheErrorCode.OPERATION_ERROR,
                                    message: 'Failed to cache next event',
                                    cause: error as Error,
                                  }),
                              )
                            : TE.right(undefined),
                        ),
                      ),
                ),
              ),
          ),
        ),
      ),
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
