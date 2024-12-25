import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from '../../../infrastructure/cache/config/cache.config';
import {
  createBaseCacheOperations,
  type BaseCacheOperations,
  type BaseDataProvider,
} from '../../../infrastructure/cache/core/base-cache';
import { createCache, type RedisCache } from '../../../infrastructure/cache/core/cache';
import { CacheError, RedisClient } from '../../../infrastructure/cache/types';
import type { PrismaPhase } from '../../../types/phases.type';

export type PhaseDataProvider = BaseDataProvider<PrismaPhase>;

export interface PhaseCacheOperations extends BaseCacheOperations<PrismaPhase> {
  readonly cachePhase: (phase: PrismaPhase) => TE.TaskEither<CacheError, void>;
  readonly getPhase: (id: string) => TE.TaskEither<CacheError, PrismaPhase | null>;
  readonly cachePhases: (phases: readonly PrismaPhase[]) => TE.TaskEither<CacheError, void>;
  readonly getAllPhases: () => TE.TaskEither<CacheError, readonly PrismaPhase[]>;
}

export const createPhaseCache = (redis: RedisClient) =>
  createCache<PrismaPhase>(redis, CachePrefix.PHASE);

export const createPhaseOperations = (
  cache: RedisCache<PrismaPhase>,
  dataProvider: PhaseDataProvider,
): PhaseCacheOperations => {
  const baseOperations = createBaseCacheOperations(
    cache,
    {
      getAll: dataProvider.getAll,
      getOne: dataProvider.getOne,
    },
    'phase',
  );

  return {
    ...baseOperations,
    cachePhase: baseOperations.cacheOne,
    getPhase: baseOperations.getOne,
    cachePhases: baseOperations.cacheMany,
    getAllPhases: baseOperations.getAll,
  };
};

export type PhaseCache = ReturnType<typeof createPhaseOperations>;
