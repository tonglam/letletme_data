// Redis Cache Implementation
//
// Provides Redis-based caching functionality with error handling.
// Implements key-value operations with TTL support.
// Uses fp-ts for functional error handling patterns.

import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import Redis from 'ioredis';
import { CacheError } from '../../types/error.type';
import { createCacheOperationError } from '../../utils/error.util';
import { redisClient } from './client';

// Type for custom serializable values
type SerializableValue = {
  __type?: string;
  value?: unknown;
};

// Error creation utilities
const createSerializationError = (message: string, cause?: unknown): CacheError =>
  createCacheOperationError({
    message,
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  });

// Serialization utilities
const serializeValue = (value: unknown): E.Either<CacheError, string> =>
  pipe(
    E.tryCatch(
      () =>
        JSON.stringify(value, (_, v) => {
          if (v instanceof Date) {
            return { __type: 'Date', value: v.toISOString() };
          }
          if (typeof v === 'number' && !Number.isFinite(v)) {
            throw new Error('Cannot serialize non-finite number');
          }
          if (v === undefined) {
            throw new Error('Cannot serialize undefined value');
          }
          return v;
        }),
      (error) => createSerializationError('Failed to serialize value', error),
    ),
  );

const deserializeValue = <T>(value: string): E.Either<CacheError, T> =>
  pipe(
    E.tryCatch(
      () =>
        JSON.parse(value, (_, v: SerializableValue) => {
          if (v && typeof v === 'object' && v.__type === 'Date' && v.value) {
            return new Date(v.value as string);
          }
          return v;
        }),
      (error) => createSerializationError('Failed to deserialize value', error),
    ),
  );

// Redis cache interface for type-safe operations
export interface RedisCache<T> {
  set: (key: string, value: T, ttl?: number) => TE.TaskEither<CacheError, void>;
  get: (key: string) => TE.TaskEither<CacheError, T | null>;
  hSet: (key: string, field: string, value: T) => TE.TaskEither<CacheError, void>;
  hGet: (key: string, field: string) => TE.TaskEither<CacheError, T | null>;
  hGetAll: (key: string) => TE.TaskEither<CacheError, Record<string, T>>;
  client: Redis;
}

// Redis cache configuration
interface RedisCacheConfig {
  keyPrefix?: string;
  defaultTTL?: number;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
}

// Helper for Redis operations with error handling
const withRedis = <T>(
  operation: () => Promise<T>,
  errorMessage: string,
): TE.TaskEither<CacheError, T> =>
  TE.tryCatch(operation, (error) =>
    createCacheOperationError({ message: errorMessage, cause: error }),
  );

// Creates a type-safe Redis cache instance
export const createRedisCache = <T>(config: RedisCacheConfig = {}): RedisCache<T> => {
  const makeKey = (key: string) => `${config.keyPrefix ?? ''}${key}`;

  // Create a new Redis client if connection options are provided
  const client = config.host
    ? new Redis({
        host: config.host,
        port: config.port ?? 6379,
        password: config.password,
        db: config.db ?? 0,
      })
    : redisClient;

  const set = (key: string, value: T, ttl?: number): TE.TaskEither<CacheError, void> =>
    pipe(
      serializeValue(value),
      E.mapLeft((error) =>
        createCacheOperationError({
          message: `Failed to serialize value for key ${key}`,
          cause: error,
        }),
      ),
      TE.fromEither,
      TE.chain((serialized) =>
        withRedis(async () => {
          const cacheKey = makeKey(key);
          const ttlValue = ttl ?? config.defaultTTL;
          if (ttlValue) {
            await client.setex(cacheKey, ttlValue, serialized);
          } else {
            await client.set(cacheKey, serialized);
          }
        }, `Failed to set cache key ${key}`),
      ),
    );

  const get = (key: string): TE.TaskEither<CacheError, T | null> =>
    pipe(
      withRedis(() => client.get(makeKey(key)), `Failed to get cache key ${key}`),
      TE.chain((value) =>
        value
          ? pipe(
              deserializeValue<T>(value),
              E.mapLeft((error) =>
                createCacheOperationError({
                  message: `Failed to deserialize value for key ${key}`,
                  cause: error,
                }),
              ),
              TE.fromEither,
            )
          : TE.right(null),
      ),
    );

  const hSet = (key: string, field: string, value: T): TE.TaskEither<CacheError, void> =>
    pipe(
      serializeValue(value),
      E.mapLeft((error) =>
        createCacheOperationError({
          message: `Failed to serialize value for hash field ${field} in key ${key}`,
          cause: error,
        }),
      ),
      TE.fromEither,
      TE.chain((serialized) =>
        withRedis(
          () => client.hset(makeKey(key), field, serialized),
          `Failed to set hash field ${field} for key ${key}`,
        ),
      ),
      TE.map(() => undefined),
    );

  const hGet = (key: string, field: string): TE.TaskEither<CacheError, T | null> =>
    pipe(
      withRedis(
        () => client.hget(makeKey(key), field),
        `Failed to get hash field ${field} for key ${key}`,
      ),
      TE.chain((value) =>
        value
          ? pipe(
              deserializeValue<T>(value),
              E.mapLeft((error) =>
                createCacheOperationError({
                  message: `Failed to deserialize value for hash field ${field} in key ${key}`,
                  cause: error,
                }),
              ),
              TE.fromEither,
            )
          : TE.right(null),
      ),
    );

  const hGetAll = (key: string): TE.TaskEither<CacheError, Record<string, T>> =>
    pipe(
      withRedis(() => client.hgetall(makeKey(key)), `Failed to get all hash fields for key ${key}`),
      TE.chain((values) =>
        values
          ? pipe(
              Object.entries(values) as Array<[string, string]>,
              A.traverse(E.Applicative)(([k, v]) =>
                pipe(
                  deserializeValue<T>(v),
                  E.map((deserialized) => [k, deserialized] as const),
                ),
              ),
              E.map((entries) => Object.fromEntries(entries) as Record<string, T>),
              E.mapLeft((error) =>
                createCacheOperationError({
                  message: `Failed to deserialize values for key ${key}`,
                  cause: error,
                }),
              ),
              TE.fromEither,
            )
          : TE.right({}),
      ),
    );

  return {
    set,
    get,
    hSet,
    hGet,
    hGetAll,
    client,
  };
};
