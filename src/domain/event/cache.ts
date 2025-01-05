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
import { CacheError } from '../../types/errors.type';
import type { Event } from '../../types/events.type';
import { createCacheOperationError } from '../../utils/error.util';
import { EventCache, EventCacheConfig, EventDataProvider } from './types';

const createError = (message: string, cause?: unknown): CacheError =>
  createCacheOperationError({ message, cause });

const parseEvent = (eventStr: string): E.Either<CacheError, Event | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(eventStr),
      (error) => createError('Failed to parse event JSON', error),
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

  const cacheKey = `${keyPrefix}::${season}`;
  const currentEventKey = `${cacheKey}::current`;
  const nextEventKey = `${cacheKey}::next`;

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => dataProvider.getAll(),
        (error) => createError('Failed to warm up cache', error),
      ),
      TE.chain((events) => (events.length > 0 ? cacheEvents(events) : TE.right(undefined))),
      TE.chainFirst(() => getCurrentEvent()),
      TE.chainFirst(() => getNextEvent()),
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
      TE.chain(
        flow(
          O.fromNullable,
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
              pipe(
                parseEvent(eventStr),
                TE.fromEither,
                TE.chain((event) =>
                  event
                    ? TE.right(event)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getOne(Number(id)),
                          (error) => createError('Failed to get event from provider', error),
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
        () => redisClient.hgetall(cacheKey),
        (error) => createError('Failed to get events from cache', error),
      ),
      TE.chain(
        flow(
          O.fromNullable,
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
                parseEvents(cachedEvents),
                TE.fromEither,
                TE.chain((events) =>
                  events.length > 0
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
        () => redisClient.get(currentEventKey),
        (error) => createError('Failed to get current event from cache', error),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getCurrentEvent(),
                  (error) => createError('Failed to get current event from provider', error),
                ),
                TE.chainFirst((event) =>
                  event
                    ? TE.tryCatch(
                        () => redisClient.set(currentEventKey, JSON.stringify(event)),
                        (error) => createError('Failed to cache current event', error),
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
                          () => dataProvider.getCurrentEvent(),
                          (error) =>
                            createError('Failed to get current event from provider', error),
                        ),
                        TE.chainFirst((event) =>
                          event
                            ? TE.tryCatch(
                                () => redisClient.set(currentEventKey, JSON.stringify(event)),
                                (error) => createError('Failed to cache current event', error),
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
        (error) => createError('Failed to get next event from cache', error),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getNextEvent(),
                  (error) => createError('Failed to get next event from provider', error),
                ),
                TE.chainFirst((event) =>
                  event
                    ? TE.tryCatch(
                        () => redisClient.set(nextEventKey, JSON.stringify(event)),
                        (error) => createError('Failed to cache next event', error),
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
                          () => dataProvider.getNextEvent(),
                          (error) => createError('Failed to get next event from provider', error),
                        ),
                        TE.chainFirst((event) =>
                          event
                            ? TE.tryCatch(
                                () => redisClient.set(nextEventKey, JSON.stringify(event)),
                                (error) => createError('Failed to cache next event', error),
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
