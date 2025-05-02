import * as TE from 'fp-ts/TaskEither';

import type { CacheError } from './error.types';

export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

export interface RetryOptions {
  attempts?: number;
  delay?: number;
}

export interface InfrastructureCacheOptions {
  ttl?: number;
  retry?: RetryOptions;
}

export interface StringOperations<T> {
  set: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  get: (key: string) => TE.TaskEither<CacheError, T | null>;
}

export interface HashOperations<T> {
  hSet: (
    key: string,
    field: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  hGet: (key: string, field: string) => TE.TaskEither<CacheError, T | null>;
  hGetAll: (key: string) => TE.TaskEither<CacheError, Record<string, T>>;
  hDel: (key: string, field: string) => TE.TaskEither<CacheError, void>;
}

export interface ListOperations<T> {
  lPush: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  lRange: (key: string, start: number, stop: number) => TE.TaskEither<CacheError, readonly T[]>;
  lRem: (key: string, count: number, value: T) => TE.TaskEither<CacheError, void>;
}

export interface SetOperations<T> {
  sAdd: (
    key: string,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  sMembers: (key: string) => TE.TaskEither<CacheError, readonly T[]>;
  sRem: (key: string, value: T) => TE.TaskEither<CacheError, void>;
}

export interface SortedSetOperations<T> {
  zAdd: (
    key: string,
    score: number,
    value: T,
    options?: InfrastructureCacheOptions,
  ) => TE.TaskEither<CacheError, void>;
  zRange: (key: string, min: number, max: number) => TE.TaskEither<CacheError, readonly T[]>;
  zRem: (key: string, value: T) => TE.TaskEither<CacheError, void>;
}

export interface CommonOperations {
  del: (key: string) => TE.TaskEither<CacheError, void>;
  keys: (pattern: string) => TE.TaskEither<CacheError, readonly string[]>;
  exists: (key: string) => TE.TaskEither<CacheError, boolean>;
  expire: (key: string, seconds: number) => TE.TaskEither<CacheError, void>;
  ttl: (key: string) => TE.TaskEither<CacheError, number>;
  disconnect: () => TE.TaskEither<CacheError, void>;
}

export interface InfrastructureCacheConfig {
  keyPrefix?: string;
  defaultTTL?: number;
  defaultRetry?: RetryOptions;
  connection: RedisConnectionConfig;
}
