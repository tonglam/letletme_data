/**
 * Cache Types Module
 *
 * Defines core types and interfaces for the cache infrastructure.
 * Provides comprehensive type definitions for cache operations.
 *
 * Features:
 * - Cache configuration types
 * - Error handling types
 * - Redis operation interfaces
 * - Type-safe operation definitions
 * - Retry mechanism types
 *
 * This module ensures type safety and consistent interfaces
 * across the cache infrastructure layer.
 */

import * as TE from 'fp-ts/TaskEither';

/**
 * Core cache configuration interface.
 * Defines basic cache behavior settings.
 */
export interface InfrastructureCacheConfig {
  /** Optional prefix for cache keys */
  keyPrefix?: string;
  /** Default time-to-live in seconds */
  defaultTTL?: number;
  /** Default retry configuration */
  defaultRetry?: RetryOptions;
}

/**
 * Redis connection configuration.
 * Defines connection parameters for Redis server.
 */
export interface RedisConnectionConfig {
  /** Redis server host */
  host: string;
  /** Redis server port */
  port: number;
  /** Optional Redis authentication password */
  password?: string;
  /** Optional Redis database number */
  db?: number;
}

/**
 * Retry mechanism configuration.
 * Defines retry behavior for failed operations.
 */
export interface RetryOptions {
  /** Number of retry attempts */
  attempts?: number;
  /** Delay between retries in milliseconds */
  delay?: number;
}

/**
 * Cache operation options.
 * Defines behavior for individual cache operations.
 */
export interface InfrastructureCacheOptions {
  /** Time-to-live in seconds for the operation */
  ttl?: number;
  /** Retry configuration for the operation */
  retry?: RetryOptions;
}

/**
 * Cache error types enumeration.
 * Defines possible error categories.
 */
export enum CacheErrorType {
  /** Connection-related errors */
  CONNECTION = 'CONNECTION',
  /** Operation-specific errors */
  OPERATION = 'OPERATION',
  /** Data serialization errors */
  SERIALIZATION = 'SERIALIZATION',
  /** Data deserialization errors */
  DESERIALIZATION = 'DESERIALIZATION',
}

/**
 * Cache error interface.
 * Provides structured error information.
 */
export interface CacheError {
  /** Type of cache error */
  type: CacheErrorType;
  /** Error message */
  message: string;
  /** Optional error cause */
  cause?: unknown;
}

/**
 * String operations interface.
 * Defines operations for string data type.
 */
export interface StringOperations<T> {
  /** Sets a string value with optional TTL */
  set: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets a string value */
  get: (key: string) => TE.TaskEither<CacheError, T | null>;
}

/**
 * Hash operations interface.
 * Defines operations for hash data type.
 */
export interface HashOperations<T> {
  /** Sets a hash field */
  hSet: (
    key: string,
    field: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets a hash field */
  hGet: (key: string, field: string) => TE.TaskEither<CacheError, T | null>;
  /** Gets all hash fields */
  hGetAll: (key: string) => TE.TaskEither<CacheError, Record<string, T>>;
  /** Deletes a hash field */
  hDel: (key: string, field: string) => TE.TaskEither<CacheError, void>;
}

/**
 * List operations interface.
 * Defines operations for list data type.
 */
export interface ListOperations<T> {
  /** Pushes a value to the list */
  lPush: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets a range of list values */
  lRange: (key: string, start: number, stop: number) => TE.TaskEither<CacheError, readonly T[]>;
  /** Removes list elements by value */
  lRem: (key: string, count: number, value: T) => TE.TaskEither<CacheError, void>;
}

/**
 * Set operations interface.
 * Defines operations for set data type.
 */
export interface SetOperations<T> {
  /** Adds a value to the set */
  sAdd: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets all set members */
  sMembers: (key: string) => TE.TaskEither<CacheError, readonly T[]>;
  /** Removes a value from the set */
  sRem: (key: string, value: T) => TE.TaskEither<CacheError, void>;
}

/**
 * Sorted set operations interface.
 * Defines operations for sorted set data type.
 */
export interface SortedSetOperations<T> {
  /** Adds a scored value to the sorted set */
  zAdd: (
    key: string,
    score: number,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets a range of sorted set values */
  zRange: (key: string, min: number, max: number) => TE.TaskEither<CacheError, readonly T[]>;
  /** Removes a value from the sorted set */
  zRem: (key: string, value: T) => TE.TaskEither<CacheError, void>;
}

/**
 * Common cache operations interface.
 * Defines operations available for all data types.
 */
export interface CommonOperations {
  /** Deletes a key */
  del: (key: string) => TE.TaskEither<CacheError, void>;
  /** Gets keys matching a pattern */
  keys: (pattern: string) => TE.TaskEither<CacheError, readonly string[]>;
  /** Checks if a key exists */
  exists: (key: string) => TE.TaskEither<CacheError, boolean>;
  /** Sets key expiration */
  expire: (key: string, seconds: number) => TE.TaskEither<CacheError, void>;
  /** Gets key time-to-live */
  ttl: (key: string) => TE.TaskEither<CacheError, number>;
  /** Disconnects from cache */
  disconnect: () => TE.TaskEither<CacheError, void>;
}
