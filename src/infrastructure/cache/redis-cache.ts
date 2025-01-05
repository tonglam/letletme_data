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

// Custom serializer to handle Date objects
const serialize = (value: unknown): string => {
  return JSON.stringify(value, (_, v) => {
    if (v instanceof Date) {
      return { __type: 'Date', value: v.toISOString() };
    }
    return v;
  });
};

// Custom deserializer to handle Date objects
const deserialize = <T>(value: string): T => {
  return JSON.parse(value, (_, v) => {
    if (v && typeof v === 'object' && v.__type === 'Date') {
      return new Date(v.value);
    }
    return v;
  });
};

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
          const serialized = serialize(value);
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
          async () => {
            const cacheKey = makeKey(key);
            const value = await redisClient.get(cacheKey);
            if (!value) return null;
            return deserialize<T>(value);
          },
          (error) =>
            createCacheOperationError({ message: `Failed to get cache key ${key}`, cause: error }),
        ),
      ),

    hSet: (key: string, field: string, value: T) =>
      TE.tryCatch(
        async () => {
          const cacheKey = makeKey(key);
          const serialized = serialize(value);
          await redisClient.hset(cacheKey, field, serialized);
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
          async () => {
            const cacheKey = makeKey(key);
            const value = await redisClient.hget(cacheKey, field);
            if (!value) return null;
            return deserialize<T>(value);
          },
          (error) =>
            createCacheOperationError({
              message: `Failed to get hash field ${field} for key ${key}`,
              cause: error,
            }),
        ),
      ),

    hGetAll: (key: string) =>
      pipe(
        TE.tryCatch(
          async () => {
            const cacheKey = makeKey(key);
            const values = await redisClient.hgetall(cacheKey);
            if (!values) return {};
            return Object.fromEntries(
              Object.entries(values).map(([k, v]) => [k, deserialize<T>(v)]),
            );
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
