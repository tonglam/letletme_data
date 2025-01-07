/**
 * Phase Cache Module
 *
 * Provides caching functionality for phase data using Redis.
 * Implements cache warming, phase retrieval, and batch operations
 * with proper type safety and error handling.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { RedisClientType } from 'redis';
import { Phase, PhaseId, Phases } from '../../types/phase.type';

// Cache error types
export interface CacheError {
  readonly code: 'CACHE_ERROR';
  readonly message: string;
}

// Cache prefix type for type safety
export type CachePrefix = 'phase';

// Default TTL values in seconds
export const DefaultTTL = {
  PHASE: 60 * 60 * 24, // 24 hours
} as const;

// Redis cache implementation with generics
export class RedisCache<T> {
  constructor(
    private readonly redis: RedisClientType,
    private readonly options: {
      readonly defaultTTL: number;
    },
  ) {}

  hSet(key: string, field: string, value: T): TE.TaskEither<CacheError, void> {
    return TE.tryCatch(
      async () => {
        await this.redis.hSet(key, field, JSON.stringify(value));
        await this.redis.expire(key, this.options.defaultTTL);
      },
      (error) => ({
        code: 'CACHE_ERROR',
        message: `Failed to set cache: ${error}`,
      }),
    );
  }

  hGet(key: string, field: string): TE.TaskEither<CacheError, T | null> {
    return TE.tryCatch(
      async () => {
        const value = await this.redis.hGet(key, field);
        return value ? (JSON.parse(value) as T) : null;
      },
      (error) => ({
        code: 'CACHE_ERROR',
        message: `Failed to get cache: ${error}`,
      }),
    );
  }

  hGetAll(key: string): TE.TaskEither<CacheError, Record<string, T>> {
    return TE.tryCatch(
      async () => {
        const values = await this.redis.hGetAll(key);
        return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, JSON.parse(v) as T]));
      },
      (error) => ({
        code: 'CACHE_ERROR',
        message: `Failed to get all cache: ${error}`,
      }),
    );
  }
}

// Data provider interface for phase data
export interface PhaseDataProvider {
  readonly getOne: (id: PhaseId) => Promise<Phase | null>;
  readonly getAll: () => Promise<Phases>;
}

// Cache configuration interface
export interface PhaseCacheConfig {
  readonly keyPrefix: CachePrefix;
  readonly season: number;
}

// Phase cache interface
export interface PhaseCache {
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
  readonly cachePhase: (phase: Phase) => TE.TaskEither<CacheError, void>;
  readonly cachePhases: (phases: Phases) => TE.TaskEither<CacheError, void>;
  readonly getPhase: (id: string) => TE.TaskEither<CacheError, Phase | null>;
  readonly getAllPhases: () => TE.TaskEither<CacheError, Phases>;
}

// Creates a phase cache instance
export const createPhaseCache = (
  redis: RedisClientType,
  dataProvider: PhaseDataProvider,
  config: PhaseCacheConfig,
): PhaseCache => {
  const cache = new RedisCache<Phase>(redis, { defaultTTL: DefaultTTL.PHASE });

  const makeKey = (id?: string) =>
    id ? `${config.keyPrefix}::${config.season}::${id}` : `${config.keyPrefix}::${config.season}`;

  const cachePhase = (phase: Phase): TE.TaskEither<CacheError, void> =>
    cache.hSet(makeKey(), phase.id.toString(), phase);

  const cachePhases = (phases: Phases): TE.TaskEither<CacheError, void> =>
    pipe(
      phases,
      TE.traverseArray(cachePhase),
      TE.map(() => void 0),
    );

  return {
    warmUp: () =>
      pipe(
        TE.tryCatch(
          () => dataProvider.getAll(),
          (error): CacheError => ({
            code: 'CACHE_ERROR',
            message: `Failed to warm up phase cache: ${error}`,
          }),
        ),
        TE.chain(cachePhases),
      ),

    cachePhase,
    cachePhases,

    getPhase: (id: string): TE.TaskEither<CacheError, Phase | null> =>
      pipe(
        cache.hGet(makeKey(), id),
        TE.chain((cached) =>
          cached
            ? TE.right(cached)
            : pipe(
                TE.tryCatch(
                  () => dataProvider.getOne(Number(id) as PhaseId),
                  (error): CacheError => ({
                    code: 'CACHE_ERROR',
                    message: `Failed to fetch phase ${id}: ${error}`,
                  }),
                ),
                TE.chain((phase) =>
                  phase
                    ? pipe(
                        cachePhase(phase),
                        TE.map(() => phase),
                      )
                    : TE.right(null),
                ),
              ),
        ),
      ),

    getAllPhases: (): TE.TaskEither<CacheError, Phases> =>
      pipe(
        cache.hGetAll(makeKey()),
        TE.map((phases) => Object.values(phases)),
      ),
  };
};
