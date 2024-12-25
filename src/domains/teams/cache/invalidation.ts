import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  CacheDependencyConfig,
  CacheError,
  CacheOperations,
  DomainType,
  KeyPatternConfig,
} from '../../../infrastructure/cache/types';

// Get all related keys for a team
export const getRelatedKeys =
  (cache: CacheOperations) =>
  (teamId: string): TE.TaskEither<CacheError, readonly string[]> => {
    const config = CacheDependencyConfig[DomainType.TEAM];
    const dependencies = config.invalidates;

    return pipe(
      dependencies,
      TE.traverseArray((dependentDomain: DomainType) =>
        cache.keys(KeyPatternConfig.related(dependentDomain, DomainType.TEAM, teamId)),
      ),
      TE.map((results) => results.flat()),
    );
  };

// Invalidate team and all related caches
export const invalidateTeamCache =
  (cache: CacheOperations) =>
  (teamId: string): TE.TaskEither<CacheError, void> =>
    pipe(
      getRelatedKeys(cache)(teamId),
      TE.chain((relatedKeys) =>
        pipe(
          cache.atomicUpdate<void>(
            {
              primary: KeyPatternConfig.primary(DomainType.TEAM, teamId),
              related: Array.from(relatedKeys),
              cascade: true,
            },
            async () => undefined,
          ),
          TE.map(() => undefined),
        ),
      ),
    );

// Invalidate multiple teams
export const invalidateTeamCaches =
  (cache: CacheOperations) =>
  (teamIds: readonly string[]): TE.TaskEither<CacheError, void> =>
    pipe(
      teamIds,
      TE.traverseArray((teamId) => invalidateTeamCache(cache)(teamId)),
      TE.map(() => undefined),
    );

// Invalidate specific team dependencies
export const invalidateTeamDependencies =
  (cache: CacheOperations) =>
  (teamId: string, dependencies: readonly DomainType[]): TE.TaskEither<CacheError, void> =>
    pipe(
      dependencies,
      TE.traverseArray((dependentDomain) =>
        pipe(
          cache.keys(KeyPatternConfig.related(dependentDomain, DomainType.TEAM, teamId)),
          TE.chain((relatedKeys) =>
            cache.atomicUpdate<void>(
              {
                primary: KeyPatternConfig.primary(dependentDomain, teamId),
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
