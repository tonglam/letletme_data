/**
 * Redis Cache Implementation Module
 *
 * Provides a type-safe, functional programming approach to Redis operations.
 * Implements various Redis data structures with comprehensive error handling.
 *
 * Features:
 * - Type-safe Redis operations
 * - Functional error handling with fp-ts
 * - Automatic serialization/deserialization
 * - Retry mechanism for operations
 * - Comprehensive Redis data type support
 * - TTL management
 * - Key prefixing
 *
 * The module provides a robust Redis implementation with proper error
 * handling and type safety throughout all operations.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { redisClient } from './client';
import {
  InfrastructureCacheConfig as CacheConfig,
  CacheError,
  CacheErrorType,
  InfrastructureCacheOptions as CacheOptions,
  CommonOperations,
  HashOperations,
  ListOperations,
  SetOperations,
  SortedSetOperations,
  StringOperations,
} from './types';

/**
 * Redis Cache Interface
 * Combines all Redis operations into a single interface.
 *
 * @template T - The type of values stored in the cache
 */
export interface RedisCache<T = unknown>
  extends StringOperations<T>,
    HashOperations<T>,
    ListOperations<T>,
    SetOperations<T>,
    SortedSetOperations<T>,
    CommonOperations {}

/**
 * Implements retry mechanism for Redis operations.
 * Handles transient failures with configurable retry attempts.
 *
 * @template T - The type of the operation result
 * @param operation - The async operation to retry
 * @param options - Retry configuration options
 * @returns Promise of the operation result
 * @throws Last encountered error if all retries fail
 */
const withRetry = async <T>(operation: () => Promise<T>, options?: CacheOptions): Promise<T> => {
  const attempts = options?.retry?.attempts ?? 1;
  const delay = options?.retry?.delay ?? 0;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1 && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
};

/**
 * Creates a Redis cache instance with the provided configuration.
 * Implements all Redis operations with type safety and error handling.
 *
 * @template T - The type of values stored in the cache
 * @param config - Redis cache configuration
 * @returns Redis cache instance with all supported operations
 */
export const createRedisCache = <T>(config: CacheConfig): RedisCache<T> => {
  const client = redisClient;
  const keyPrefix = config.keyPrefix ?? '';
  const defaultTTL = config.defaultTTL;
  const defaultRetry = config.defaultRetry;

  /**
   * Generates prefixed key for Redis operations.
   * Ensures key namespace isolation.
   */
  const makeKey = (key: string) => `${keyPrefix}${key}`;

  /**
   * Serializes value to string for Redis storage.
   * Handles complex data types.
   */
  const serialize = (value: T): TE.TaskEither<CacheError, string> =>
    TE.tryCatch(
      () => Promise.resolve(JSON.stringify(value)),
      (error): CacheError => ({
        type: CacheErrorType.SERIALIZATION,
        message: 'Failed to serialize value',
        cause: error,
      }),
    );

  /**
   * Deserializes string from Redis to typed value.
   * Handles complex data types.
   */
  const deserialize = (value: string): TE.TaskEither<CacheError, T> =>
    TE.tryCatch(
      () => Promise.resolve(JSON.parse(value) as T),
      (error): CacheError => ({
        type: CacheErrorType.DESERIALIZATION,
        message: 'Failed to deserialize value',
        cause: error,
      }),
    );

  // String operations
  const set = (key: string, value: T, options?: CacheOptions): TE.TaskEither<CacheError, void> =>
    pipe(
      serialize(value),
      TE.chain((serialized) =>
        TE.tryCatch(
          () =>
            withRetry(
              async () => {
                const ttl = options?.ttl ?? defaultTTL;
                if (ttl) {
                  await client.setEx(makeKey(key), ttl, serialized);
                } else {
                  await client.set(makeKey(key), serialized);
                }
              },
              { ...options, retry: options?.retry ?? defaultRetry },
            ),
          (error): CacheError => ({
            type: CacheErrorType.OPERATION,
            message: 'Failed to set value',
            cause: error,
          }),
        ),
      ),
    );

  const get = (key: string): TE.TaskEither<CacheError, T | null> =>
    pipe(
      TE.tryCatch(
        () => withRetry(() => client.get(makeKey(key)), { retry: defaultRetry }),
        (error): CacheError => ({
          type: CacheErrorType.OPERATION,
          message: 'Failed to get value',
          cause: error,
        }),
      ),
      TE.chain((value) => (value ? deserialize(value) : TE.of(null))),
    );

  // Hash operations
  const hSet = (
    key: string,
    field: string,
    value: T,
    options?: CacheOptions,
  ): TE.TaskEither<CacheError, void> =>
    pipe(
      serialize(value),
      TE.chain((serialized) =>
        TE.tryCatch(
          () =>
            withRetry(
              async () => {
                await client.hSet(makeKey(key), field, serialized);
                if (options?.ttl) {
                  await client.expire(makeKey(key), options.ttl);
                }
              },
              { ...options, retry: options?.retry ?? defaultRetry },
            ),
          (error): CacheError => ({
            type: CacheErrorType.OPERATION,
            message: 'Failed to set hash field',
            cause: error,
          }),
        ),
      ),
    );

  const hGet = (key: string, field: string): TE.TaskEither<CacheError, T | null> =>
    pipe(
      TE.tryCatch(
        () => withRetry(() => client.hGet(makeKey(key), field), { retry: defaultRetry }),
        (error): CacheError => ({
          type: CacheErrorType.OPERATION,
          message: 'Failed to get hash field',
          cause: error,
        }),
      ),
      TE.chain((value) => (value ? deserialize(value) : TE.of(null))),
    );

  const hGetAll = (key: string): TE.TaskEither<CacheError, Record<string, T>> =>
    pipe(
      TE.tryCatch(
        () => withRetry(() => client.hGetAll(makeKey(key)), { retry: defaultRetry }),
        (error): CacheError => ({
          type: CacheErrorType.OPERATION,
          message: 'Failed to get all hash fields',
          cause: error,
        }),
      ),
      TE.chain((values) =>
        pipe(
          Object.entries(values),
          TE.traverseArray(([k, v]) =>
            pipe(
              deserialize(v),
              TE.map((value) => [k, value] as const),
            ),
          ),
          TE.map(Object.fromEntries),
        ),
      ),
    );

  const hDel = (key: string, field: string): TE.TaskEither<CacheError, void> =>
    TE.tryCatch(
      async () => {
        await withRetry(() => client.hDel(makeKey(key), field), { retry: defaultRetry });
      },
      (error): CacheError => ({
        type: CacheErrorType.OPERATION,
        message: 'Failed to delete hash field',
        cause: error,
      }),
    );

  // List operations
  const lPush = (key: string, value: T, options?: CacheOptions): TE.TaskEither<CacheError, void> =>
    pipe(
      serialize(value),
      TE.chain((serialized) =>
        TE.tryCatch(
          async () => {
            await withRetry(
              async () => {
                await client.lPush(makeKey(key), serialized);
                if (options?.ttl) {
                  await client.expire(makeKey(key), options.ttl);
                }
              },
              { ...options, retry: options?.retry ?? defaultRetry },
            );
          },
          (error): CacheError => ({
            type: CacheErrorType.OPERATION,
            message: 'Failed to push to list',
            cause: error,
          }),
        ),
      ),
    );

  const lRange = (
    key: string,
    start: number,
    stop: number,
  ): TE.TaskEither<CacheError, readonly T[]> =>
    pipe(
      TE.tryCatch(
        () => withRetry(() => client.lRange(makeKey(key), start, stop), { retry: defaultRetry }),
        (error): CacheError => ({
          type: CacheErrorType.OPERATION,
          message: 'Failed to get list range',
          cause: error,
        }),
      ),
      TE.chain(TE.traverseArray(deserialize)),
    );

  const lRem = (key: string, count: number, value: T): TE.TaskEither<CacheError, void> =>
    pipe(
      serialize(value),
      TE.chain((serialized) =>
        TE.tryCatch(
          async () => {
            await withRetry(() => client.lRem(makeKey(key), count, serialized), {
              retry: defaultRetry,
            });
          },
          (error): CacheError => ({
            type: CacheErrorType.OPERATION,
            message: 'Failed to remove from list',
            cause: error,
          }),
        ),
      ),
    );

  // Set operations
  const sAdd = (key: string, value: T, options?: CacheOptions): TE.TaskEither<CacheError, void> =>
    pipe(
      serialize(value),
      TE.chain((serialized) =>
        TE.tryCatch(
          async () => {
            await withRetry(
              async () => {
                await client.sAdd(makeKey(key), serialized);
                if (options?.ttl) {
                  await client.expire(makeKey(key), options.ttl);
                }
              },
              { ...options, retry: options?.retry ?? defaultRetry },
            );
          },
          (error): CacheError => ({
            type: CacheErrorType.OPERATION,
            message: 'Failed to add to set',
            cause: error,
          }),
        ),
      ),
    );

  const sMembers = (key: string): TE.TaskEither<CacheError, readonly T[]> =>
    pipe(
      TE.tryCatch(
        () => withRetry(() => client.sMembers(makeKey(key)), { retry: defaultRetry }),
        (error): CacheError => ({
          type: CacheErrorType.OPERATION,
          message: 'Failed to get set members',
          cause: error,
        }),
      ),
      TE.chain(TE.traverseArray(deserialize)),
    );

  const sRem = (key: string, value: T): TE.TaskEither<CacheError, void> =>
    pipe(
      serialize(value),
      TE.chain((serialized) =>
        TE.tryCatch(
          async () => {
            await withRetry(() => client.sRem(makeKey(key), serialized), { retry: defaultRetry });
          },
          (error): CacheError => ({
            type: CacheErrorType.OPERATION,
            message: 'Failed to remove from set',
            cause: error,
          }),
        ),
      ),
    );

  // Sorted Set operations
  const zAdd = (
    key: string,
    score: number,
    value: T,
    options?: CacheOptions,
  ): TE.TaskEither<CacheError, void> =>
    pipe(
      serialize(value),
      TE.chain((serialized) =>
        TE.tryCatch(
          async () => {
            await withRetry(
              async () => {
                await client.zAdd(makeKey(key), [{ score, value: serialized }]);
                if (options?.ttl) {
                  await client.expire(makeKey(key), options.ttl);
                }
              },
              { ...options, retry: options?.retry ?? defaultRetry },
            );
          },
          (error): CacheError => ({
            type: CacheErrorType.OPERATION,
            message: 'Failed to add to sorted set',
            cause: error,
          }),
        ),
      ),
    );

  const zRange = (key: string, min: number, max: number): TE.TaskEither<CacheError, readonly T[]> =>
    pipe(
      TE.tryCatch(
        () => withRetry(() => client.zRange(makeKey(key), min, max), { retry: defaultRetry }),
        (error): CacheError => ({
          type: CacheErrorType.OPERATION,
          message: 'Failed to get sorted set range',
          cause: error,
        }),
      ),
      TE.chain(TE.traverseArray(deserialize)),
    );

  const zRem = (key: string, value: T): TE.TaskEither<CacheError, void> =>
    pipe(
      serialize(value),
      TE.chain((serialized) =>
        TE.tryCatch(
          async () => {
            await withRetry(() => client.zRem(makeKey(key), serialized), { retry: defaultRetry });
          },
          (error): CacheError => ({
            type: CacheErrorType.OPERATION,
            message: 'Failed to remove from sorted set',
            cause: error,
          }),
        ),
      ),
    );

  // Common operations
  const del = (key: string): TE.TaskEither<CacheError, void> =>
    TE.tryCatch(
      async () => {
        await withRetry(() => client.del(makeKey(key)), { retry: defaultRetry });
      },
      (error): CacheError => ({
        type: CacheErrorType.OPERATION,
        message: 'Failed to delete key',
        cause: error,
      }),
    );

  const keys = (pattern: string): TE.TaskEither<CacheError, readonly string[]> =>
    TE.tryCatch(
      () => withRetry(() => client.keys(makeKey(pattern)), { retry: defaultRetry }),
      (error): CacheError => ({
        type: CacheErrorType.OPERATION,
        message: 'Failed to get keys',
        cause: error,
      }),
    );

  const exists = (key: string): TE.TaskEither<CacheError, boolean> =>
    TE.tryCatch(
      async () => {
        const result = await withRetry(() => client.exists(makeKey(key)), { retry: defaultRetry });
        return result === 1;
      },
      (error): CacheError => ({
        type: CacheErrorType.OPERATION,
        message: 'Failed to check key existence',
        cause: error,
      }),
    );

  const expire = (key: string, seconds: number): TE.TaskEither<CacheError, void> =>
    TE.tryCatch(
      async () => {
        await withRetry(() => client.expire(makeKey(key), seconds), { retry: defaultRetry });
      },
      (error): CacheError => ({
        type: CacheErrorType.OPERATION,
        message: 'Failed to set expiry',
        cause: error,
      }),
    );

  const ttl = (key: string): TE.TaskEither<CacheError, number> =>
    TE.tryCatch(
      () => withRetry(() => client.ttl(makeKey(key)), { retry: defaultRetry }),
      (error): CacheError => ({
        type: CacheErrorType.OPERATION,
        message: 'Failed to get TTL',
        cause: error,
      }),
    );

  const disconnect = (): TE.TaskEither<CacheError, void> =>
    TE.tryCatch(
      async () => {
        await client.quit();
      },
      (error): CacheError => ({
        type: CacheErrorType.CONNECTION,
        message: 'Failed to disconnect',
        cause: error,
      }),
    );

  return {
    // String operations
    set,
    get,
    // Hash operations
    hSet,
    hGet,
    hGetAll,
    hDel,
    // List operations
    lPush,
    lRange,
    lRem,
    // Set operations
    sAdd,
    sMembers,
    sRem,
    // Sorted Set operations
    zAdd,
    zRange,
    zRem,
    // Common operations
    del,
    keys,
    exists,
    expire,
    ttl,
    disconnect,
  };
};
