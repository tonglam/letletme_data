import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CacheTTL } from '../../../config/cache/cache.config';
import { CacheError, CacheErrorType, CacheWrapper, RedisClient } from '../types';
import { createCacheError } from './utils';

// Base interfaces
export interface BaseDataProvider<T> {
  readonly getAll: () => Promise<readonly T[]>;
  readonly getOne: (id: string) => Promise<T | null>;
}

export interface RedisCache<T> {
  readonly set: (key: string, value: T, ttl?: number) => TE.TaskEither<CacheError, void>;
  readonly get: (key: string) => TE.TaskEither<CacheError, T | null>;
  readonly del: (key: string) => TE.TaskEither<CacheError, number>;
}

export interface BaseCacheOperations<T> {
  readonly cacheOne: (item: T) => TE.TaskEither<CacheError, void>;
  readonly getOne: (id: string) => TE.TaskEither<CacheError, T | null>;
  readonly cacheMany: (items: readonly T[]) => TE.TaskEither<CacheError, void>;
  readonly getAll: () => TE.TaskEither<CacheError, readonly T[]>;
  readonly cacheBatch: (items: readonly T[], ttl?: number) => TE.TaskEither<CacheError, void>;
  readonly getMany: (ids: string[]) => TE.TaskEither<CacheError, (T | null)[]>;
  readonly invalidateMany: (ids: string[]) => TE.TaskEither<CacheError, void>;
}

// Helper functions
const tryCatch = <T>(
  operation: () => Promise<T>,
  type: CacheErrorType,
  errorMessage: string,
): TE.TaskEither<CacheError, T> =>
  TE.tryCatch(operation, (error) => createCacheError(type, errorMessage, error));

// Low-level Redis cache factory
export const createCache = <T>(redis: RedisClient, prefix: string): RedisCache<T> => {
  if (!prefix?.trim()) {
    throw new Error('Cache prefix is required');
  }

  return {
    set: (key: string, value: T, ttl?: number) =>
      pipe(
        TE.right({ key: key.trim(), ttl }),
        TE.chain(({ key, ttl }) =>
          !key
            ? TE.left(createCacheError(CacheErrorType.VALIDATION, 'Invalid cache key'))
            : ttl !== undefined && (isNaN(ttl) || ttl < 0)
              ? TE.left(createCacheError(CacheErrorType.VALIDATION, 'Invalid TTL value'))
              : TE.right({ key, ttl }),
        ),
        TE.chain(() =>
          TE.tryCatch(
            async () => JSON.stringify({ value, timestamp: Date.now() } satisfies CacheWrapper<T>),
            (error) =>
              createCacheError(CacheErrorType.OPERATION, 'Failed to stringify cache value', error),
          ),
        ),
        TE.chain((data) => redis.set(`${prefix}:${key}`, data, ttl)),
      ),

    get: (key: string) =>
      pipe(
        TE.right(key.trim()),
        TE.chain((k) =>
          k
            ? redis.get(`${prefix}:${k}`)
            : TE.left(createCacheError(CacheErrorType.VALIDATION, 'Invalid cache key')),
        ),
        TE.chain(
          O.fold(
            () => TE.right<CacheError, T | null>(null),
            (data) =>
              TE.tryCatch(
                async () => {
                  const parsed = JSON.parse(data) as CacheWrapper<T>;
                  if (!parsed || typeof parsed !== 'object') {
                    throw new Error('Invalid cache data structure');
                  }
                  return parsed.value;
                },
                (error) =>
                  createCacheError(CacheErrorType.OPERATION, 'Failed to parse cache value', error),
              ),
          ),
        ),
      ),

    del: (key: string) => redis.del(`${prefix}:${key}`),
  };
};

// High-level cache operations factory
export const createBaseCacheOperations = <T extends { id: number | string; createdAt?: Date }>(
  cache: RedisCache<T>,
  dataProvider: BaseDataProvider<T>,
  entityName: string,
): BaseCacheOperations<T> => {
  const setOne = (item: T): TE.TaskEither<CacheError, void> =>
    pipe(
      cache.set(
        String(item.id),
        { ...item, createdAt: item.createdAt ?? new Date() },
        CacheTTL.METADATA,
      ),
      TE.mapLeft((error) =>
        createCacheError(CacheErrorType.OPERATION, `Failed to cache ${entityName}`, error),
      ),
    );

  const getFromCache = (id: string): TE.TaskEither<CacheError, O.Option<T>> =>
    pipe(
      cache.get(id),
      TE.map(O.fromNullable),
      TE.mapLeft((error) =>
        createCacheError(
          CacheErrorType.CONNECTION,
          `Failed to get ${entityName} from cache`,
          error,
        ),
      ),
    );

  const getFromProvider = (id: string): TE.TaskEither<CacheError, O.Option<T>> =>
    pipe(
      tryCatch(
        () => dataProvider.getOne(id),
        CacheErrorType.OPERATION,
        `Failed to get ${entityName} from provider`,
      ),
      TE.map(O.fromNullable),
    );

  const getAllFromProvider = (): TE.TaskEither<CacheError, readonly T[]> =>
    tryCatch(
      () => dataProvider.getAll(),
      CacheErrorType.OPERATION,
      `Failed to fetch ${entityName}s data`,
    );

  const fetchAndCache = (id: string): TE.TaskEither<CacheError, T | null> =>
    pipe(
      getFromProvider(id),
      TE.chain(
        O.fold(
          () => TE.right(null),
          (item) =>
            pipe(
              setOne(item),
              TE.map(() => item as T | null),
            ),
        ),
      ),
    );

  const fetchAllAndCache = (): TE.TaskEither<CacheError, readonly T[]> =>
    pipe(
      getAllFromProvider(),
      TE.chain((items) =>
        pipe(
          items,
          TE.traverseArray(setOne),
          TE.map(() => items),
        ),
      ),
    );

  const cacheBatch = (
    items: readonly T[],
    ttl = CacheTTL.METADATA,
  ): TE.TaskEither<CacheError, void> =>
    pipe(
      tryCatch(
        () => Promise.all(items.map((item) => cache.set(String(item.id), item, ttl)())),
        CacheErrorType.OPERATION,
        `Failed to cache ${entityName}s batch`,
      ),
      TE.map(() => undefined),
    );

  const getMany = (ids: string[]): TE.TaskEither<CacheError, (T | null)[]> =>
    pipe(
      ids,
      TE.traverseArray((id) =>
        pipe(
          getFromCache(id),
          TE.chain(
            O.fold(
              () => fetchAndCache(id),
              (item) => TE.right(item),
            ),
          ),
        ),
      ),
      TE.map((results) => Array.from(results)),
    );

  return {
    cacheOne: setOne,
    getOne: (id) =>
      pipe(
        getFromCache(id),
        TE.chain(
          O.fold(
            () => fetchAndCache(id),
            (item) => TE.right(item),
          ),
        ),
      ),
    cacheMany: (items) =>
      pipe(
        items,
        TE.traverseArray(setOne),
        TE.map(() => undefined),
      ),
    getAll: () => pipe(fetchAllAndCache(), TE.orElse(getAllFromProvider)),
    cacheBatch,
    getMany,
    invalidateMany: (ids) =>
      pipe(
        ids,
        TE.traverseArray((id) =>
          pipe(
            cache.del(id),
            TE.mapLeft((error) =>
              createCacheError(
                CacheErrorType.OPERATION,
                `Failed to invalidate ${entityName}`,
                error,
              ),
            ),
          ),
        ),
        TE.map(() => undefined),
      ),
  };
};
