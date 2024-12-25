import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from '../../../infrastructure/cache/config/cache.config';
import {
  createBaseCacheOperations,
  type BaseCacheOperations,
  type BaseDataProvider,
} from '../../../infrastructure/cache/core/base-cache';
import { createCache, type RedisCache } from '../../../infrastructure/cache/core/cache';
import { CacheError, RedisClient } from '../../../infrastructure/cache/types';
import type { PrismaEvent } from '../../../types/events.type';

export type EventDataProvider = BaseDataProvider<PrismaEvent>;

export interface EventCacheOperations extends BaseCacheOperations<PrismaEvent> {
  readonly cacheEvent: (event: PrismaEvent) => TE.TaskEither<CacheError, void>;
  readonly getEvent: (id: string) => TE.TaskEither<CacheError, PrismaEvent | null>;
  readonly cacheEvents: (events: readonly PrismaEvent[]) => TE.TaskEither<CacheError, void>;
  readonly getAllEvents: () => TE.TaskEither<CacheError, readonly PrismaEvent[]>;
  readonly getCurrentEvent: () => TE.TaskEither<CacheError, PrismaEvent | null>;
  readonly getNextEvent: () => TE.TaskEither<CacheError, PrismaEvent | null>;
}

export const createEventCache = (redis: RedisClient) =>
  createCache<PrismaEvent>(redis, CachePrefix.EVENT);

export const createEventOperations = (
  cache: RedisCache<PrismaEvent>,
  dataProvider: EventDataProvider,
): EventCacheOperations => {
  const baseOperations = createBaseCacheOperations(
    cache,
    {
      getAll: dataProvider.getAll,
      getOne: dataProvider.getOne,
    },
    'event',
  );

  return {
    ...baseOperations,
    cacheEvent: baseOperations.cacheOne,
    getEvent: baseOperations.getOne,
    cacheEvents: baseOperations.cacheMany,
    getAllEvents: baseOperations.getAll,
    getCurrentEvent: () =>
      pipe(
        baseOperations.getAll(),
        TE.map((events) => events.find((e) => e.isCurrent) ?? null),
      ),
    getNextEvent: () =>
      pipe(
        baseOperations.getAll(),
        TE.map((events) => events.find((e) => e.isNext) ?? null),
      ),
  };
};

export type EventCache = ReturnType<typeof createEventOperations>;
