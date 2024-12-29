/**
 * Core types and interfaces for the cache infrastructure layer.
 * Implements a type-safe, functional programming approach to caching operations.
 */

import * as TE from 'fp-ts/TaskEither';

/**
 * Cache Error Types
 *
 * Defines error types and configurations for cache operations.
 * Provides type-safe error handling for Redis operations.
 */

/**
 * Cache error types for different operation failures
 */
export enum CacheErrorType {
  CONNECTION = 'CONNECTION',
  SET = 'SET',
  GET = 'GET',
  DELETE = 'DELETE',
  EXISTS = 'EXISTS',
  TTL = 'TTL',
  SERIALIZATION = 'SERIALIZATION',
  DESERIALIZATION = 'DESERIALIZATION',
  OPERATION = 'OPERATION',
}

/**
 * Cache error structure for operation failures
 */
export interface CacheError {
  type: CacheErrorType;
  message: string;
  cause?: unknown;
}

/**
 * Redis connection configuration
 * Defines required and optional parameters for Redis server connection
 */
export interface RedisConnectionConfig {
  /** Redis server hostname or IP address */
  host: string;
  /** Redis server port number */
  port: number;
  /** Redis server authentication password */
  password?: string;
  /** Redis database index number */
  db?: number;
}

/**
 * Retry mechanism configuration for cache operations
 * Controls retry behavior for failed cache operations
 */
export interface RetryOptions {
  /** Maximum number of retry attempts */
  attempts?: number;
  /** Delay between retry attempts in milliseconds */
  delay?: number;
}

/**
 * Cache operation options
 * Defines per-operation configuration overrides
 */
export interface InfrastructureCacheOptions {
  /** Operation-specific Time-To-Live in seconds */
  ttl?: number;
  /** Operation-specific retry configuration */
  retry?: RetryOptions;
}

/**
 * String operations interface
 * Provides type-safe operations for string value caching
 */
export interface StringOperations<T> {
  /** Stores a value with optional TTL and retry configuration */
  set: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Retrieves a previously stored value by key */
  get: (key: string) => TE.TaskEither<CacheError, T | null>;
}

/**
 * Hash operations interface
 * Provides type-safe operations for hash table caching
 */
export interface HashOperations<T> {
  /** Stores a value in a hash field with optional TTL and retry configuration */
  hSet: (
    key: string,
    field: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Retrieves a value from a hash field by key and field name */
  hGet: (key: string, field: string) => TE.TaskEither<CacheError, T | null>;
  /** Retrieves all field-value pairs from a hash */
  hGetAll: (key: string) => TE.TaskEither<CacheError, Record<string, T>>;
  /** Removes a field from a hash */
  hDel: (key: string, field: string) => TE.TaskEither<CacheError, void>;
}

/**
 * List operations interface
 * Provides type-safe operations for list data structure caching
 */
export interface ListOperations<T> {
  /** Pushes a value to the head of a list with optional TTL and retry configuration */
  lPush: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Retrieves a range of elements from a list */
  lRange: (key: string, start: number, stop: number) => TE.TaskEither<CacheError, readonly T[]>;
  /** Removes elements equal to value from a list */
  lRem: (key: string, count: number, value: T) => TE.TaskEither<CacheError, void>;
}

/**
 * Set operations interface
 * Provides type-safe operations for set data structure caching
 */
export interface SetOperations<T> {
  /** Adds a value to a set with optional TTL and retry configuration */
  sAdd: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Retrieves all members of a set */
  sMembers: (key: string) => TE.TaskEither<CacheError, readonly T[]>;
  /** Removes a value from a set */
  sRem: (key: string, value: T) => TE.TaskEither<CacheError, void>;
}

/**
 * Sorted set operations interface
 * Provides type-safe operations for sorted set data structure caching
 */
export interface SortedSetOperations<T> {
  /** Adds a scored value to a sorted set with optional TTL and retry configuration */
  zAdd: (
    key: string,
    score: number,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Retrieves elements with scores within the given range */
  zRange: (key: string, min: number, max: number) => TE.TaskEither<CacheError, readonly T[]>;
  /** Removes a value from a sorted set */
  zRem: (key: string, value: T) => TE.TaskEither<CacheError, void>;
}

/**
 * Common cache operations interface
 * Provides type-safe operations common to all cache data structures
 */
export interface CommonOperations {
  /** Removes a key and its associated value from the cache */
  del: (key: string) => TE.TaskEither<CacheError, void>;
  /** Retrieves all keys matching the specified pattern */
  keys: (pattern: string) => TE.TaskEither<CacheError, readonly string[]>;
  /** Checks if a key exists in the cache */
  exists: (key: string) => TE.TaskEither<CacheError, boolean>;
  /** Sets a key's time-to-live in seconds */
  expire: (key: string, seconds: number) => TE.TaskEither<CacheError, void>;
  /** Retrieves the remaining time-to-live for a key in seconds */
  ttl: (key: string) => TE.TaskEither<CacheError, number>;
  /** Closes the cache connection */
  disconnect: () => TE.TaskEither<CacheError, void>;
}

/**
 * Infrastructure cache configuration
 * Defines global settings for cache operations
 */
export interface InfrastructureCacheConfig {
  /** Global prefix for all cache keys */
  keyPrefix?: string;
  /** Global default Time-To-Live in seconds */
  defaultTTL?: number;
  /** Global retry configuration for cache operations */
  defaultRetry?: RetryOptions;
  /** Redis connection configuration */
  connection: RedisConnectionConfig;
}
