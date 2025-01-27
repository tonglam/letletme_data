/**
 * Phase Cache Module
 *
 * Provides caching functionality for phase data using Redis.
 * Implements cache warming, phase retrieval, and batch operations
 * with proper type safety and error handling.
 */

import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import { CachePrefix } from '../../config/cache/cache.config';
import { redisClient } from '../../infrastructure/cache/client';
import type { RedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError, CacheErrorCode, createCacheError } from '../../types/error.type';
import type { Phase } from '../../types/phase.type';
import { PhaseCache, PhaseCacheConfig, PhaseDataProvider } from './types';

const parsePhase = (phaseStr: string): E.Either<CacheError, Phase | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(phaseStr),
      (error: unknown) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse phase JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as Phase)
        : E.right(null),
    ),
  );

const parsePhases = (phases: Record<string, string>): E.Either<CacheError, Phase[]> =>
  pipe(
    Object.values(phases),
    (phaseStrs) =>
      phaseStrs.map((str) =>
        pipe(
          parsePhase(str),
          E.getOrElse<CacheError, Phase | null>(() => null),
        ),
      ),
    (parsedPhases) => parsedPhases.filter((phase): phase is Phase => phase !== null),
    (validPhases) => E.right(validPhases),
  );

export const createPhaseCache = (
  cache: RedisCache<Phase>,
  dataProvider: PhaseDataProvider,
  config: PhaseCacheConfig = {
    keyPrefix: CachePrefix.PHASE,
    season: getCurrentSeason(),
  },
): PhaseCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const phases = await dataProvider.getAll();
          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();
          const cacheMulti = redisClient.multi();
          phases.forEach((phase) => {
            cacheMulti.hset(baseKey, phase.id.toString(), JSON.stringify(phase));
          });
          await cacheMulti.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to warm up cache',
            cause: error as Error,
          }),
      ),
    );

  const cachePhase = (phase: Phase): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hset(baseKey, phase.id.toString(), JSON.stringify(phase)),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache phase',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
    );

  const cachePhases = (phases: readonly Phase[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (phases.length === 0) return;
          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();
          const cacheMulti = redisClient.multi();
          phases.forEach((phase) => {
            cacheMulti.hset(baseKey, phase.id.toString(), JSON.stringify(phase));
          });
          await cacheMulti.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache phases',
            cause: error as Error,
          }),
      ),
    );

  const getPhase = (id: string): TE.TaskEither<CacheError, Phase | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, id),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get phase from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getOne(Number(id)),
                  (error: unknown) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get phase from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chainFirst((phase) => (phase ? cachePhase(phase) : TE.right(undefined))),
              ),
            (phaseStr) =>
              pipe(
                parsePhase(phaseStr),
                TE.fromEither,
                TE.chain((phase) =>
                  phase
                    ? TE.right(phase)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getOne(Number(id)),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get phase from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chainFirst((phase) => (phase ? cachePhase(phase) : TE.right(undefined))),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  const getAllPhases = (): TE.TaskEither<CacheError, readonly Phase[]> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get phases from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getAll(),
                  (error: unknown) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get phases from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chain((phases) =>
                  pipe(
                    cachePhases(phases),
                    TE.map(() => phases),
                  ),
                ),
              ),
            (cachedPhases) =>
              pipe(
                parsePhases(cachedPhases),
                TE.fromEither,
                TE.chain((phases) =>
                  phases.length > 0
                    ? TE.right(phases)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getAll(),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get phases from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chain((phases) =>
                          pipe(
                            cachePhases(phases),
                            TE.map(() => phases),
                          ),
                        ),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  return {
    warmUp,
    cachePhase,
    cachePhases,
    getPhase,
    getAllPhases,
  };
};
