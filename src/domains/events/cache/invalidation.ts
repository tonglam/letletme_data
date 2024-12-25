import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  CacheDependencyConfig,
  CacheError,
  CacheOperations,
  DomainType,
  KeyPatternConfig,
} from '../../../infrastructure/cache/types';

// Get all related keys for an event
export const getRelatedKeys =
  (cache: CacheOperations) =>
  (eventId: string): TE.TaskEither<CacheError, readonly string[]> => {
    const config = CacheDependencyConfig[DomainType.EVENT];
    const dependencies = config.invalidates;

    return pipe(
      dependencies,
      TE.traverseArray((dependentDomain: DomainType) =>
        cache.keys(KeyPatternConfig.related(dependentDomain, DomainType.EVENT, eventId)),
      ),
      TE.map((results) => results.flat()),
    );
  };

// Invalidate event and all related caches
export const invalidateEventCache =
  (cache: CacheOperations) =>
  (eventId: string): TE.TaskEither<CacheError, void> =>
    pipe(
      getRelatedKeys(cache)(eventId),
      TE.chain((relatedKeys) =>
        pipe(
          cache.atomicUpdate<void>(
            {
              primary: KeyPatternConfig.primary(DomainType.EVENT, eventId),
              related: Array.from(relatedKeys),
              cascade: true,
            },
            async () => undefined,
          ),
          TE.map(() => undefined),
        ),
      ),
    );

// Invalidate multiple events
export const invalidateEventCaches =
  (cache: CacheOperations) =>
  (eventIds: readonly string[]): TE.TaskEither<CacheError, void> =>
    pipe(
      eventIds,
      TE.traverseArray((eventId) => invalidateEventCache(cache)(eventId)),
      TE.map(() => undefined),
    );

// Invalidate specific event dependencies
export const invalidateEventDependencies =
  (cache: CacheOperations) =>
  (eventId: string, dependencies: readonly DomainType[]): TE.TaskEither<CacheError, void> =>
    pipe(
      dependencies,
      TE.traverseArray((dependentDomain) =>
        pipe(
          cache.keys(KeyPatternConfig.related(dependentDomain, DomainType.EVENT, eventId)),
          TE.chain((relatedKeys) =>
            cache.atomicUpdate<void>(
              {
                primary: KeyPatternConfig.primary(dependentDomain, eventId),
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
