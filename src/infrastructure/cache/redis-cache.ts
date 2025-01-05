// Redis Cache Implementation
//
// Provides Redis-based caching functionality with error handling.
// Implements key-value operations with TTL support.
// Uses fp-ts for functional error handling patterns.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CacheError } from '../../types/errors.type';
import { createCacheOperationError } from '../../utils/error.util';
import { redisClient } from './client';

// Redis cache interface for type-safe operations
export interface RedisCache<T> {
  set: (key: string, value: T, ttl?: number) => TE.TaskEither<CacheError, void>;
  get: (key: string) => TE.TaskEither<CacheError, T | null>;
  hSet: (key: string, field: string, value: T) => TE.TaskEither<CacheError, void>;
  hGet: (key: string, field: string) => TE.TaskEither<CacheError, T | null>;
  hGetAll: (key: string) => TE.TaskEither<CacheError, Record<string, T>>;
}

// Redis cache configuration
interface RedisCacheConfig {
  keyPrefix?: string;
  defaultTTL?: number;
}

// Creates a type-safe Redis cache instance
export const createRedisCache = <T>(config: RedisCacheConfig = {}): RedisCache<T> => {
  const makeKey = (key: string) => `${config.keyPrefix ?? ''}${key}`;

  const cacheInstance: RedisCache<T> = {
    set: (key: string, value: T, ttl?: number) =>
      TE.tryCatch(
        async () => {
          const serialized = JSON.stringify(value);
          const cacheKey = makeKey(key);
          const ttlValue = ttl ?? config.defaultTTL;
          if (ttlValue) {
            await redisClient.setex(cacheKey, ttlValue, serialized);
          } else {
            await redisClient.set(cacheKey, serialized);
          }
        },
        (error) =>
          createCacheOperationError({ message: `Failed to set cache key ${key}`, cause: error }),
      ),

    get: (key: string) =>
      pipe(
        TE.tryCatch(
          () => redisClient.get(makeKey(key)),
          (error) =>
            createCacheOperationError({ message: `Failed to get cache key ${key}`, cause: error }),
        ),
        TE.map((value) => (value ? (JSON.parse(value) as T) : null)),
      ),

    hSet: (key: string, field: string, value: T) =>
      TE.tryCatch(
        async () => {
          const serialized = JSON.stringify(value);
          await redisClient.hset(makeKey(key), field, serialized);
        },
        (error) =>
          createCacheOperationError({
            message: `Failed to set hash field ${field} for key ${key}`,
            cause: error,
          }),
      ),

    hGet: (key: string, field: string) =>
      pipe(
        TE.tryCatch(
          () => redisClient.hget(makeKey(key), field),
          (error) =>
            createCacheOperationError({
              message: `Failed to get hash field ${field} for key ${key}`,
              cause: error,
            }),
        ),
        TE.map((value) => (value ? (JSON.parse(value) as T) : null)),
      ),

    hGetAll: (key: string) =>
      pipe(
        TE.tryCatch(
          async () => {
            const fields = await redisClient.hgetall(makeKey(key));
            if (!fields) return {};
            return Object.entries(fields).reduce<Record<string, T>>((acc, [field, value]) => {
              try {
                if (value) {
                  acc[field] = JSON.parse(value) as T;
                }
              } catch (error) {
                console.error(`Failed to parse value for field ${field}:`, error);
              }
              return acc;
            }, {});
          },
          (error) =>
            createCacheOperationError({
              message: `Failed to get all hash fields for key ${key}`,
              cause: error,
            }),
        ),
      ),
  };

  return cacheInstance;
};
