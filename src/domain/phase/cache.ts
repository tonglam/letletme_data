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
import { CacheError } from '../../types/error.type';
import type { Phase } from '../../types/phase.type';
import { createCacheOperationError } from '../../utils/error.util';
import { PhaseCache, PhaseCacheConfig, PhaseDataProvider } from './types';

const createError = (message: string, cause?: unknown): CacheError =>
  createCacheOperationError({ message, cause });

const parsePhase = (phaseStr: string): E.Either<CacheError, Phase | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(phaseStr),
      (error) => createError('Failed to parse phase JSON', error),
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
    season: Number(getCurrentSeason()),
  },
): PhaseCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const phases = await dataProvider.getAll();

          // Delete base key before caching
          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();

          // Cache all phases
          const cacheMulti = redisClient.multi();
          phases.forEach((phase) => {
            cacheMulti.hset(baseKey, String(phase.id), JSON.stringify(phase));
          });
          await cacheMulti.exec();
        },
        (error) => createError('Failed to warm up cache', error),
      ),
    );

  const cachePhase = (phase: Phase): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hset(baseKey, String(phase.id), JSON.stringify(phase)),
        (error) => createError('Failed to cache phase', error),
      ),
      TE.map(() => undefined),
    );

  const cachePhases = (phases: readonly Phase[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (phases.length === 0) return;

          // Delete base key before caching
          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();

          // Cache all phases
          const cacheMulti = redisClient.multi();
          phases.forEach((phase) => {
            cacheMulti.hset(baseKey, String(phase.id), JSON.stringify(phase));
          });
          await cacheMulti.exec();
        },
        (error) => createError('Failed to cache phases', error),
      ),
    );

  const getPhase = (id: string): TE.TaskEither<CacheError, Phase | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, id),
        (error) => createError('Failed to get phase from cache', error),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getOne(Number(id)),
                  (error) => createError('Failed to get phase from provider', error),
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
                          (error) => createError('Failed to get phase from provider', error),
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
        (error) => createError('Failed to get phases from cache', error),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getAll(),
                  (error) => createError('Failed to get phases from provider', error),
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
                          (error) => createError('Failed to get phases from provider', error),
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
