import type { Either } from 'fp-ts/Either';
import type { Option } from 'fp-ts/Option';
import type { TaskEither } from 'fp-ts/TaskEither';
import * as t from 'io-ts';
import type { ChainableCommander, Redis, RedisOptions } from 'ioredis';
import type { APIError } from '../http/common/errors';

// Redis types
export type RetryStrategy = (retryAttempt: number) => number | null;

// Redis Pool Configuration
export interface RedisPoolConfig {
  readonly minConnections: number;
  readonly maxConnections: number;
  readonly acquireTimeout: number;
  readonly idleTimeout: number;
}

export interface PoolConfig
  extends Pick<RedisPoolConfig, 'minConnections' | 'maxConnections' | 'acquireTimeout'> {}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  minConnections: 2,
  maxConnections: 10,
  acquireTimeout: 5000,
} as const;

export interface PoolState {
  readonly connections: Redis[];
  readonly activeConnections: Set<Redis>;
}

// Redis Configuration
export interface RedisConfig extends Omit<RedisOptions, 'tls'> {
  readonly host: string;
  readonly port: number;
  readonly password?: string;
  readonly maxRetriesPerRequest?: number;
  readonly retryStrategy?: RetryStrategy;
  readonly lazyConnect?: boolean;
  readonly enableOfflineQueue?: boolean;
  readonly pool?: Partial<RedisPoolConfig>;
  readonly commandTimeout?: number;
  readonly reconnectStrategy?: {
    readonly maxAttempts: number;
    readonly delay: number;
  };
}

export const RedisConfigCodec = t.intersection([
  t.type({
    host: t.string,
    port: t.number,
  }),
  t.partial({
    password: t.string,
    maxRetriesPerRequest: t.number,
    lazyConnect: t.boolean,
    enableOfflineQueue: t.boolean,
  }),
]);

// Redis Client types
export type ConnectionStatus = Option<boolean>;

export interface RedisClient {
  readonly connect: () => TaskEither<CacheError, void>;
  readonly disconnect: () => TaskEither<CacheError, void>;
  readonly get: (key: string) => TaskEither<CacheError, Option<string>>;
  readonly set: (key: string, value: string, ttl?: number) => TaskEither<CacheError, void>;
  readonly del: (...keys: readonly string[]) => TaskEither<CacheError, number>;
  readonly keys: (pattern: string) => TaskEither<CacheError, readonly string[]>;
  readonly multi: () => TaskEither<CacheError, ChainableCommander>;
  readonly isReady: () => boolean;
  readonly exec: (multi: ChainableCommander) => TaskEither<CacheError, Array<unknown>>;
  readonly ping: () => TaskEither<CacheError, string>;
}

// Error types
export const CacheErrorType = {
  CONNECTION: 'CONNECTION_ERROR',
  OPERATION: 'OPERATION_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  WARMING: 'WARMING_ERROR',
} as const;

export type CacheErrorType = (typeof CacheErrorType)[keyof typeof CacheErrorType];

// Cache error interface
export interface CacheError {
  readonly type: CacheErrorType;
  readonly message: string;
  readonly cause?: unknown;
  readonly timestamp?: string;
  readonly context?: {
    readonly operation?: string;
    readonly key?: string;
    readonly attempt?: number;
    readonly delay?: number;
    readonly timeout?: number;
    readonly retryConfig?: {
      readonly maxRetries: number;
      readonly currentAttempt: number;
    };
  };
}

// Error transformation types
export type CacheErrorCreator = (
  type: CacheErrorType,
  message: string,
  cause?: unknown,
) => CacheError;
export type CacheErrorTransformer = (message: string, cause?: unknown) => CacheError;
export type APIErrorTransformer = (error: CacheError) => APIError;

// Data validation types
export type CodecValidator<T> = {
  decode: (u: unknown) => Either<unknown, T>;
};

export type DataValidator<T> = (u: unknown) => TaskEither<APIError, T>;

// Cache wrapper type
export interface CacheWrapper<T> {
  readonly value: T;
  readonly timestamp: number;
}

// Retry configuration
export interface RetryConfig {
  readonly maxRetries: number;
  readonly retryDelay: number;
  readonly maxDelay: number;
  readonly timeout: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryDelay: 1000,
  maxDelay: 5000,
  timeout: 5000,
} as const;

// TTL configurations in seconds
export const TTLConfig = {
  METADATA: 30 * 24 * 60 * 60, // 30 days
  DERIVED_DATA: 24 * 60 * 60, // 24 hours
  TEMPORARY: 60 * 60, // 1 hour
} as const;

// Domain types for type safety
export const DomainType = {
  EVENT: 'events',
  PHASE: 'phases',
  TEAM: 'teams',
  STANDING: 'standings',
} as const;

export type DomainType = (typeof DomainType)[keyof typeof DomainType];

// Cache key pattern configuration
export const KeyPatternConfig = {
  primary: (domain: DomainType, id: string) => `${domain}:${id}`,
  related: (domain: DomainType, relatedDomain: DomainType, id: string) =>
    `${domain}:${relatedDomain}:${id}`,
  pattern: (domain: DomainType, pattern: string) => `${domain}:${pattern}:*`,
} as const;

// Cache dependency types
export interface CacheDependencyInfo {
  readonly invalidates: readonly DomainType[];
  readonly ttl?: number;
  readonly warmingConfig?: {
    readonly batchSize?: number;
    readonly retryAttempts?: number;
    readonly retryDelay?: number;
    readonly refreshInterval?: number;
  };
}

// Cache dependency configuration
export const CacheDependencyConfig: Record<DomainType, CacheDependencyInfo> = {
  [DomainType.EVENT]: {
    invalidates: [DomainType.PHASE, DomainType.TEAM],
    ttl: TTLConfig.METADATA,
  },
  [DomainType.PHASE]: {
    invalidates: [DomainType.STANDING],
    ttl: TTLConfig.METADATA,
  },
  [DomainType.TEAM]: {
    invalidates: [DomainType.STANDING],
    ttl: TTLConfig.METADATA,
  },
  [DomainType.STANDING]: {
    invalidates: [],
    ttl: TTLConfig.DERIVED_DATA,
    warmingConfig: {
      batchSize: 50,
      retryAttempts: 2,
      refreshInterval: 6 * 60 * 60 * 1000, // 6 hours
    },
  },
} as const;

// Invalidation pattern type
export const InvalidationPatternCodec = t.type({
  primary: t.string,
  related: t.array(t.string),
  cascade: t.boolean,
});

export type InvalidationPattern = t.TypeOf<typeof InvalidationPatternCodec>;

// Default warming configuration
export const DefaultWarmingConfig = {
  batchSize: 100,
  retryAttempts: 3,
  retryDelay: 1000,
  periodicRefreshInterval: 12 * 60 * 60 * 1000, // 12 hours
} as const;

// Logging types
export type LogInfo = {
  message: string;
  context?: Record<string, unknown>;
};

export type LogError = {
  message: string;
  context: {
    type: CacheErrorType;
    cause?: unknown;
  };
};

// Cache Operations types
export interface CacheOperations {
  readonly keys: (pattern: string) => TaskEither<CacheError, readonly string[]>;
  readonly set: <T>(
    domain: DomainType,
    id: string,
    value: T,
    ttl?: number,
  ) => TaskEither<CacheError, void>;
  readonly get: <T>(domain: DomainType, id: string) => TaskEither<CacheError, Option<T>>;
  readonly invalidate: (
    domain: DomainType,
    id: string,
    cascade?: boolean,
  ) => TaskEither<CacheError, number>;
  readonly atomicUpdate: <T>(
    pattern: InvalidationPattern,
    updateFn: () => Promise<T>,
  ) => TaskEither<CacheError, T>;
  readonly checkHealth: () => TaskEither<CacheError, boolean>;
}

// Batch Operation Configuration
export const BATCH_SIZE = 1000;

// Cache Warmer types
export interface CacheItem {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface DataProvider<T extends CacheItem> {
  readonly getData: () => Promise<readonly T[]>;
  readonly getDomain: () => DomainType;
}

export interface CacheWarmerOperations {
  readonly initialize: () => TaskEither<CacheError, void>;
  readonly verifyIntegrity: () => TaskEither<CacheError, boolean>;
}

// Cache Module types
export interface CacheModuleOperations {
  readonly initialize: () => TaskEither<CacheError, void>;
  readonly initializeWarmer: (
    dataProviders: readonly DataProvider<CacheItem>[],
  ) => TaskEither<CacheError, void>;
  readonly getCache: () => Either<CacheError, CacheOperations>;
  readonly getRedisClient: () => Either<CacheError, RedisClient>;
  readonly shutdown: () => TaskEither<CacheError, void>;
}

export interface CacheModuleState {
  readonly redisClient: Option<RedisClient>;
  readonly cacheOps: Option<CacheOperations>;
  readonly warmerOps: Option<CacheWarmerOperations>;
}

export interface Cache {
  get: <T>(key: string) => TaskEither<Error, T>;
  set: <T>(key: string, value: T) => TaskEither<Error, void>;
  del: (key: string) => TaskEither<Error, void>;
}

export interface CacheStrategy {
  get<T>(key: string): Promise<Option<T>>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  invalidate(pattern: string): Promise<void>;
  clear(): Promise<void>;
  disconnect(): Promise<void>;
}
