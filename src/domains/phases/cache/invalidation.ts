import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  CacheDependencyConfig,
  CacheError,
  CacheOperations,
  DomainType,
  KeyPatternConfig,
} from '../../../infrastructure/cache/types';

// Get all related keys for a phase
export const getRelatedKeys =
  (cache: CacheOperations) =>
  (phaseId: string): TE.TaskEither<CacheError, readonly string[]> => {
    const config = CacheDependencyConfig[DomainType.PHASE];
    const dependencies = config.invalidates;

    return pipe(
      dependencies,
      TE.traverseArray((dependentDomain: DomainType) =>
        cache.keys(KeyPatternConfig.related(dependentDomain, DomainType.PHASE, phaseId)),
      ),
      TE.map((results) => results.flat()),
    );
  };

// Invalidate phase and all related caches
export const invalidatePhaseCache =
  (cache: CacheOperations) =>
  (phaseId: string): TE.TaskEither<CacheError, void> =>
    pipe(
      getRelatedKeys(cache)(phaseId),
      TE.chain((relatedKeys) =>
        pipe(
          cache.atomicUpdate<void>(
            {
              primary: KeyPatternConfig.primary(DomainType.PHASE, phaseId),
              related: Array.from(relatedKeys),
              cascade: true,
            },
            async () => undefined,
          ),
          TE.map(() => undefined),
        ),
      ),
    );

// Invalidate multiple phases
export const invalidatePhaseCaches =
  (cache: CacheOperations) =>
  (phaseIds: readonly string[]): TE.TaskEither<CacheError, void> =>
    pipe(
      phaseIds,
      TE.traverseArray((phaseId) => invalidatePhaseCache(cache)(phaseId)),
      TE.map(() => undefined),
    );

// Invalidate specific phase dependencies
export const invalidatePhaseDependencies =
  (cache: CacheOperations) =>
  (phaseId: string, dependencies: readonly DomainType[]): TE.TaskEither<CacheError, void> =>
    pipe(
      dependencies,
      TE.traverseArray((dependentDomain) =>
        pipe(
          cache.keys(KeyPatternConfig.related(dependentDomain, DomainType.PHASE, phaseId)),
          TE.chain((relatedKeys) =>
            cache.atomicUpdate<void>(
              {
                primary: KeyPatternConfig.primary(dependentDomain, phaseId),
                related: Array.from(relatedKeys),
                cascade: false,
              },
              async () => undefined,
            ),
          ),
          TE.map(() => undefined),
        ),
      ),
      TE.map(() => undefined),
    );
