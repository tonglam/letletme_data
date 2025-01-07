/**
 * Phase Cache Module
 *
 * Provides caching functionality for phase data using Redis.
 * Implements cache warming, phase retrieval, and batch operations
 * with proper type safety and error handling.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../config/cache/cache.config';
import type { RedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError } from '../../types/error.type';
import type { Phase } from '../../types/phase.type';
import { createCacheOperationError } from '../../utils/error.util';
import { PhaseCache, PhaseCacheConfig, PhaseDataProvider } from './types';

const createError = (message: string, cause?: unknown): CacheError =>
  createCacheOperationError({ message, cause });

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
          await Promise.all(phases.map((phase) => cache.hSet(baseKey, String(phase.id), phase)()));
        },
        (error) => createError('Failed to warm up cache', error),
      ),
    );

  const cachePhase = (phase: Phase): TE.TaskEither<CacheError, void> =>
    pipe(
      cache.hSet(baseKey, String(phase.id), phase),
      TE.mapLeft((error) => createError('Failed to cache phase', error)),
    );

  const cachePhases = (phases: readonly Phase[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (phases.length === 0) return;
          await Promise.all(phases.map((phase) => cache.hSet(baseKey, String(phase.id), phase)()));
        },
        (error) => createError('Failed to cache phases', error),
      ),
    );

  const getPhase = (id: string): TE.TaskEither<CacheError, Phase | null> =>
    pipe(
      cache.hGet(baseKey, id),
      TE.mapLeft((error) => createError('Failed to get phase from cache', error)),
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
    );

  const getAllPhases = (): TE.TaskEither<CacheError, readonly Phase[]> =>
    pipe(
      cache.hGetAll(baseKey),
      TE.mapLeft((error) => createError('Failed to get phases from cache', error)),
      TE.chain((phases) =>
        Object.values(phases).length > 0
          ? TE.right(Object.values(phases))
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
    );

  return {
    warmUp,
    cachePhase,
    cachePhases,
    getPhase,
    getAllPhases,
  };
};
