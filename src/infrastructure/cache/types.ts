/**
 * Cache Types Module
 *
 * Core types and interfaces for the cache infrastructure.
 */

import * as TE from 'fp-ts/TaskEither';

/**
 * Core cache configuration interface
 */
export interface InfrastructureCacheConfig {
  /** Cache key prefix */
  keyPrefix?: string;
  /** Default TTL in seconds */
  defaultTTL?: number;
  /** Retry configuration */
  defaultRetry?: RetryOptions;
}

/**
 * Redis connection configuration
 */
export interface RedisConnectionConfig {
  /** Server host */
  host: string;
  /** Server port */
  port: number;
  /** Auth password */
  password?: string;
  /** Database number */
  db?: number;
}

/**
 * Retry mechanism configuration
 */
export interface RetryOptions {
  /** Retry attempts */
  attempts?: number;
  /** Retry delay in ms */
  delay?: number;
}

/**
 * Cache operation options
 */
export interface InfrastructureCacheOptions {
  /** TTL in seconds */
  ttl?: number;
  /** Retry config */
  retry?: RetryOptions;
}

/**
 * Cache error types
 */
export enum CacheErrorType {
  /** Connection errors */
  CONNECTION = 'CONNECTION',
  /** Operation errors */
  OPERATION = 'OPERATION',
  /** Serialization errors */
  SERIALIZATION = 'SERIALIZATION',
  /** Deserialization errors */
  DESERIALIZATION = 'DESERIALIZATION',
}

/**
 * Cache error interface
 */
export interface CacheError {
  /** Error type */
  type: CacheErrorType;
  /** Error message */
  message: string;
  /** Error cause */
  cause?: unknown;
}

/**
 * String operations interface
 */
export interface StringOperations<T> {
  /** Sets string value */
  set: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets string value */
  get: (key: string) => TE.TaskEither<CacheError, T | null>;
}

/**
 * Hash operations interface
 */
export interface HashOperations<T> {
  /** Sets hash field */
  hSet: (
    key: string,
    field: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets hash field */
  hGet: (key: string, field: string) => TE.TaskEither<CacheError, T | null>;
  /** Gets all hash fields */
  hGetAll: (key: string) => TE.TaskEither<CacheError, Record<string, T>>;
  /** Deletes hash field */
  hDel: (key: string, field: string) => TE.TaskEither<CacheError, void>;
}

/**
 * List operations interface
 */
export interface ListOperations<T> {
  /** Pushes value to list */
  lPush: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets list range */
  lRange: (key: string, start: number, stop: number) => TE.TaskEither<CacheError, readonly T[]>;
  /** Removes list elements */
  lRem: (key: string, count: number, value: T) => TE.TaskEither<CacheError, void>;
}

/**
 * Set operations interface
 */
export interface SetOperations<T> {
  /** Adds set value */
  sAdd: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets set members */
  sMembers: (key: string) => TE.TaskEither<CacheError, readonly T[]>;
  /** Removes set value */
  sRem: (key: string, value: T) => TE.TaskEither<CacheError, void>;
}

/**
 * Sorted set operations interface
 */
export interface SortedSetOperations<T> {
  /** Adds scored value */
  zAdd: (
    key: string,
    score: number,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  /** Gets score range */
  zRange: (key: string, min: number, max: number) => TE.TaskEither<CacheError, readonly T[]>;
  /** Removes value */
  zRem: (key: string, value: T) => TE.TaskEither<CacheError, void>;
}

/**
 * Common cache operations interface
 */
export interface CommonOperations {
  /** Deletes key */
  del: (key: string) => TE.TaskEither<CacheError, void>;
  /** Gets matching keys */
  keys: (pattern: string) => TE.TaskEither<CacheError, readonly string[]>;
  /** Checks key existence */
  exists: (key: string) => TE.TaskEither<CacheError, boolean>;
  /** Sets expiration */
  expire: (key: string, seconds: number) => TE.TaskEither<CacheError, void>;
  /** Gets TTL */
  ttl: (key: string) => TE.TaskEither<CacheError, number>;
  /** Disconnects cache */
  disconnect: () => TE.TaskEither<CacheError, void>;
}
