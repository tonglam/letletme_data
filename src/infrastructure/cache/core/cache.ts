import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CacheError, CacheErrorType, CacheWrapper, RedisClient } from '../types';

// Error handling
const createError = (type: CacheErrorType, message: string, cause?: unknown): CacheError => ({
  type,
  message,
  cause: cause instanceof Error ? cause : new Error(String(cause)),
});

// Cache interface
export interface RedisCache<T> {
  readonly set: (key: string, value: T, ttl?: number) => TE.TaskEither<CacheError, void>;
  readonly get: (key: string) => TE.TaskEither<CacheError, T | null>;
  readonly del: (key: string) => TE.TaskEither<CacheError, number>;
}

// Cache factory
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
            ? TE.left(createError(CacheErrorType.VALIDATION, 'Invalid cache key'))
            : ttl !== undefined && (isNaN(ttl) || ttl < 0)
              ? TE.left(createError(CacheErrorType.VALIDATION, 'Invalid TTL value'))
              : TE.right({ key, ttl }),
        ),
        TE.chain(() =>
          TE.tryCatch(
            async () => JSON.stringify({ value, timestamp: Date.now() } satisfies CacheWrapper<T>),
            (error) =>
              createError(CacheErrorType.OPERATION, 'Failed to stringify cache value', error),
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
            : TE.left(createError(CacheErrorType.VALIDATION, 'Invalid cache key')),
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
                  createError(CacheErrorType.OPERATION, 'Failed to parse cache value', error),
              ),
          ),
        ),
      ),

    del: (key: string) => redis.del(`${prefix}:${key}`),
  };
};
