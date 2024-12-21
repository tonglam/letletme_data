import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix, CacheTTL } from '../../../infrastructure/cache/config/cache.config';
import { createCache, type RedisCache } from '../../../infrastructure/cache/core/cache';
import { CacheError, CacheErrorType, RedisClient } from '../../../infrastructure/cache/types';
import type { PrismaPhase } from '../../../types/phase.type';

export interface PhaseDataProvider {
  readonly getAllPhases: () => Promise<readonly PrismaPhase[]>;
  readonly getPhase: (id: string) => Promise<PrismaPhase | null>;
}

export interface PhaseCacheOperations {
  readonly cachePhase: (phase: PrismaPhase) => TE.TaskEither<CacheError, void>;
  readonly getPhase: (id: string) => TE.TaskEither<CacheError, PrismaPhase | null>;
  readonly cachePhases: (phases: readonly PrismaPhase[]) => TE.TaskEither<CacheError, void>;
  readonly getAllPhases: () => TE.TaskEither<CacheError, readonly PrismaPhase[]>;
  cacheBatch: (phases: readonly PrismaPhase[], ttl?: number) => TE.TaskEither<CacheError, void>;
  getMany: (ids: string[]) => TE.TaskEither<CacheError, (PrismaPhase | null)[]>;
  invalidateMany: (ids: string[]) => TE.TaskEither<CacheError, void>;
}

const createError = (type: CacheErrorType, message: string, cause?: unknown): CacheError => ({
  type,
  message,
  cause,
});

const tryCatch = <T>(
  operation: () => Promise<T>,
  type: CacheErrorType,
  errorMessage: string,
): TE.TaskEither<CacheError, T> =>
  TE.tryCatch(operation, (error) => createError(type, errorMessage, error));

export const createPhaseCache = (redis: RedisClient): RedisCache<PrismaPhase> =>
  createCache<PrismaPhase>(redis, CachePrefix.PHASE);

export const createPhaseOperations = (
  cache: RedisCache<PrismaPhase>,
  dataProvider: PhaseDataProvider,
): PhaseCacheOperations => {
  const setPhase = (phase: PrismaPhase): TE.TaskEither<CacheError, void> =>
    pipe(
      cache.set(
        String(phase.id),
        { ...phase, createdAt: phase.createdAt ?? new Date() },
        CacheTTL.METADATA,
      ),
      TE.mapLeft((error) => createError(CacheErrorType.OPERATION, 'Failed to cache phase', error)),
    );

  const getFromCache = (id: string): TE.TaskEither<CacheError, O.Option<PrismaPhase>> =>
    pipe(
      cache.get(id),
      TE.map(O.fromNullable),
      TE.mapLeft((error) =>
        createError(CacheErrorType.CONNECTION, 'Failed to get phase from cache', error),
      ),
    );

  const getFromProvider = (id: string): TE.TaskEither<CacheError, O.Option<PrismaPhase>> =>
    pipe(
      tryCatch(
        () => dataProvider.getPhase(id),
        CacheErrorType.OPERATION,
        'Failed to get phase from provider',
      ),
      TE.map(O.fromNullable),
    );

  const getAllFromProvider = (): TE.TaskEither<CacheError, readonly PrismaPhase[]> =>
    tryCatch(
      () => dataProvider.getAllPhases(),
      CacheErrorType.OPERATION,
      'Failed to fetch phases data',
    );

  const fetchAndCache = (id: string): TE.TaskEither<CacheError, PrismaPhase | null> =>
    pipe(
      getFromProvider(id),
      TE.chain(
        O.fold(
          () => TE.right(null),
          (phase) =>
            pipe(
              setPhase(phase),
              TE.map(() => phase as PrismaPhase | null),
            ),
        ),
      ),
    );

  const fetchAllAndCache = (): TE.TaskEither<CacheError, readonly PrismaPhase[]> =>
    pipe(
      getAllFromProvider(),
      TE.chain((phases) =>
        pipe(
          phases,
          TE.traverseArray(setPhase),
          TE.map(() => phases),
        ),
      ),
    );

  const cacheBatch = (
    phases: readonly PrismaPhase[],
    ttl = CacheTTL.METADATA,
  ): TE.TaskEither<CacheError, void> =>
    pipe(
      tryCatch(
        () => Promise.all(phases.map((phase) => cache.set(String(phase.id), phase, ttl)())),
        CacheErrorType.OPERATION,
        'Failed to cache phases batch',
      ),
      TE.map(() => undefined),
    );

  const getMany = (ids: string[]): TE.TaskEither<CacheError, (PrismaPhase | null)[]> =>
    pipe(
      ids,
      TE.traverseArray((id) =>
        pipe(
          getFromCache(id),
          TE.chain(
            O.fold(
              () => fetchAndCache(id),
              (phase) => TE.right(phase),
            ),
          ),
        ),
      ),
      TE.map((results) => Array.from(results) as (PrismaPhase | null)[]),
    );

  return {
    cachePhase: setPhase,
    getPhase: (id) =>
      pipe(
        getFromCache(id),
        TE.chain(
          O.fold(
            () => fetchAndCache(id),
            (phase) => TE.right(phase),
          ),
        ),
      ),
    cachePhases: (phases) =>
      pipe(
        phases,
        TE.traverseArray(setPhase),
        TE.map(() => undefined),
      ),
    getAllPhases: () => pipe(fetchAllAndCache(), TE.orElse(getAllFromProvider)),
    cacheBatch,
    getMany,
    invalidateMany: (ids) =>
      pipe(
        ids,
        TE.traverseArray((id) =>
          pipe(
            cache.del(id),
            TE.mapLeft((error) =>
              createError(CacheErrorType.OPERATION, 'Failed to invalidate phase', error),
            ),
          ),
        ),
        TE.map(() => undefined),
      ),
  };
};

export type PhaseCache = ReturnType<typeof createPhaseOperations>;
