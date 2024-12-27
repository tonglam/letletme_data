import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from '../config/cache.config';
import { CacheError, RedisClient } from '../types';
import {
  createBaseCacheOperations,
  createCache,
  type BaseCacheOperations,
  type BaseDataProvider,
  type RedisCache,
} from './cache';

export interface DomainCacheOperations<T extends { id: number | string }>
  extends BaseCacheOperations<T> {
  readonly cacheItem: (item: T) => TE.TaskEither<CacheError, void>;
  readonly getItem: (id: string) => TE.TaskEither<CacheError, T | null>;
  readonly cacheItems: (items: readonly T[]) => TE.TaskEither<CacheError, void>;
  readonly getAllItems: () => TE.TaskEither<CacheError, readonly T[]>;
}

export const createDomainCache = <T extends { id: number | string }>(
  redis: RedisClient,
  prefix: keyof typeof CachePrefix,
  dataProvider: BaseDataProvider<T>,
  entityName: string,
  extendOperations?: (
    baseOps: DomainCacheOperations<T>,
    cache: RedisCache<T>,
  ) => Partial<Record<string, unknown>>,
) => {
  const cache = createCache<T>(redis, CachePrefix[prefix]);
  const baseOperations = createBaseCacheOperations(cache, dataProvider, entityName);

  const domainOperations: DomainCacheOperations<T> = {
    ...baseOperations,
    cacheItem: baseOperations.cacheOne,
    getItem: baseOperations.getOne,
    cacheItems: baseOperations.cacheMany,
    getAllItems: baseOperations.getAll,
  };

  return {
    ...domainOperations,
    ...(extendOperations ? extendOperations(domainOperations, cache) : {}),
  } as const;
};

export type DomainCache<T extends { id: number | string }> = ReturnType<
  typeof createDomainCache<T>
>;
