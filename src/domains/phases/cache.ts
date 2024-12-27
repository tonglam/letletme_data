import * as TE from 'fp-ts/TaskEither';
import { type BaseDataProvider } from '../../infrastructure/cache/core/cache';
import {
  createDomainCache,
  type DomainCacheOperations,
} from '../../infrastructure/cache/core/domain-cache';
import { createCacheInvalidation } from '../../infrastructure/cache/core/invalidation';
import {
  CacheError,
  CacheOperations,
  DomainType,
  RedisClient,
} from '../../infrastructure/cache/types';
import type { PrismaPhase } from '../../types/phases.type';

export type PhaseDataProvider = BaseDataProvider<PrismaPhase>;

export interface PhaseCacheOperations extends DomainCacheOperations<PrismaPhase> {
  readonly cachePhase: (phase: PrismaPhase) => TE.TaskEither<CacheError, void>;
  readonly getPhase: (id: string) => TE.TaskEither<CacheError, PrismaPhase | null>;
  readonly cachePhases: (phases: readonly PrismaPhase[]) => TE.TaskEither<CacheError, void>;
  readonly getAllPhases: () => TE.TaskEither<CacheError, readonly PrismaPhase[]>;
}

export const createPhaseOperations = (
  redis: RedisClient,
  dataProvider: PhaseDataProvider,
): PhaseCacheOperations => {
  const domainCache = createDomainCache(redis, 'PHASE', dataProvider, 'phase', (baseOps) => ({
    cachePhase: baseOps.cacheItem,
    getPhase: baseOps.getItem,
    cachePhases: baseOps.cacheItems,
    getAllPhases: baseOps.getAllItems,
  }));

  return domainCache as PhaseCacheOperations;
};

export const createPhaseInvalidation = (cache: CacheOperations) => ({
  ...createCacheInvalidation(cache, DomainType.PHASE),
});

export type PhaseCache = ReturnType<typeof createPhaseOperations>;
