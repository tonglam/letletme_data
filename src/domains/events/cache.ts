import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { type BaseDataProvider } from '../../infrastructure/cache/core/cache';
import {
  createDomainCache,
  type DomainCacheOperations,
} from '../../infrastructure/cache/core/domain-cache';
import { createCacheInvalidation } from '../../infrastructure/cache/core/invalidation';
import {
  CacheError,
  CacheOperations,
  DomainType,
  RedisClient,
} from '../../infrastructure/cache/types';
import type { PrismaEvent } from '../../types/events.type';

export type EventDataProvider = BaseDataProvider<PrismaEvent>;

export interface EventCacheOperations extends DomainCacheOperations<PrismaEvent> {
  readonly cacheEvent: (event: PrismaEvent) => TE.TaskEither<CacheError, void>;
  readonly getEvent: (id: string) => TE.TaskEither<CacheError, PrismaEvent | null>;
  readonly cacheEvents: (events: readonly PrismaEvent[]) => TE.TaskEither<CacheError, void>;
  readonly getAllEvents: () => TE.TaskEither<CacheError, readonly PrismaEvent[]>;
  readonly getCurrentEvent: () => TE.TaskEither<CacheError, PrismaEvent | null>;
  readonly getNextEvent: () => TE.TaskEither<CacheError, PrismaEvent | null>;
}

export const createEventOperations = (
  redis: RedisClient,
  dataProvider: EventDataProvider,
): EventCacheOperations => {
  const domainCache = createDomainCache(redis, 'EVENT', dataProvider, 'event', (baseOps) => ({
    cacheEvent: baseOps.cacheItem,
    getEvent: baseOps.getItem,
    cacheEvents: baseOps.cacheItems,
    getAllEvents: baseOps.getAllItems,
    getCurrentEvent: () =>
      pipe(
        baseOps.getAllItems(),
        TE.map((events) => events.find((e) => e.isCurrent) ?? null),
      ),
    getNextEvent: () =>
      pipe(
        baseOps.getAllItems(),
        TE.map((events) => events.find((e) => e.isNext) ?? null),
      ),
  }));

  return domainCache as EventCacheOperations;
};

export const createEventInvalidation = (cache: CacheOperations) => ({
  ...createCacheInvalidation(cache, DomainType.EVENT),
});

export type EventCache = ReturnType<typeof createEventOperations>;
