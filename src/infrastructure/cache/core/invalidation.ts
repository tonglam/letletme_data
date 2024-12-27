import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../../http/common/errors';
import {
  CacheDependencyConfig,
  CacheError,
  CacheOperations,
  DomainType,
  KeyPatternConfig,
  convertTaskEither,
} from '../types';

/**
 * Get all related keys for a domain entity
 */
export const getRelatedKeys =
  (cache: CacheOperations) =>
  (domain: DomainType) =>
  (id: string): TE.TaskEither<CacheError, readonly string[]> => {
    const config = CacheDependencyConfig[domain];
    const dependencies = config.invalidates;

    return pipe(
      dependencies,
      TE.traverseArray((dependentDomain: DomainType) =>
        cache.keys(KeyPatternConfig.related(dependentDomain, domain, id)),
      ),
      TE.map((results) => results.flat()),
    );
  };

/**
 * Invalidate single entity cache and all related caches
 */
export const invalidateCache =
  (cache: CacheOperations) =>
  (domain: DomainType) =>
  (id: string): TE.TaskEither<CacheError, void> =>
    pipe(
      getRelatedKeys(cache)(domain)(id),
      TE.chain((relatedKeys) =>
        pipe(
          cache.atomicUpdate<void>(
            {
              primary: KeyPatternConfig.primary(domain, id),
              related: Array.from(relatedKeys),
              cascade: true,
            },
            async () => undefined,
          ),
          TE.map(() => undefined),
        ),
      ),
    );

/**
 * Invalidate multiple entity caches
 */
export const invalidateCaches =
  (cache: CacheOperations) =>
  (domain: DomainType) =>
  (ids: readonly string[]): TE.TaskEither<CacheError, void> =>
    pipe(
      ids,
      TE.traverseArray((id) => invalidateCache(cache)(domain)(id)),
      TE.map(() => undefined),
    );

/**
 * Invalidate specific entity dependencies
 */
export const invalidateDependencies =
  (cache: CacheOperations) =>
  (domain: DomainType) =>
  (id: string, dependencies: readonly DomainType[]): TE.TaskEither<CacheError, void> =>
    pipe(
      dependencies,
      TE.traverseArray((dependentDomain) =>
        pipe(
          cache.keys(KeyPatternConfig.related(dependentDomain, domain, id)),
          TE.chain((relatedKeys) =>
            cache.atomicUpdate<void>(
              {
                primary: KeyPatternConfig.primary(dependentDomain, id),
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

/**
 * Create domain-specific cache invalidation operations
 */
export const createCacheInvalidation = (cache: CacheOperations, domain: DomainType) => ({
  invalidateOne: invalidateCache(cache)(domain),
  invalidateMany: invalidateCaches(cache)(domain),
  invalidateDependencies: (id: string, deps: readonly DomainType[]) =>
    invalidateDependencies(cache)(domain)(id, deps),
});

interface CreateInvalidationOptions {
  readonly formatKey?: (id: number | string) => string;
  readonly parseId?: (id: number | string) => string;
}

export const createDomainInvalidation = <T extends CacheOperations>(
  cache: T,
  domain: DomainType,
  options: CreateInvalidationOptions = {},
) => {
  const baseInvalidation = createCacheInvalidation(cache as CacheOperations, domain);
  const { formatKey = String, parseId = String } = options;

  const invalidateOne = (id: number | string): TE.TaskEither<APIError, void> =>
    convertTaskEither(baseInvalidation.invalidateOne(formatKey(id)));

  const invalidateMany = (ids: readonly (number | string)[]): TE.TaskEither<APIError, void> =>
    convertTaskEither(baseInvalidation.invalidateMany(ids.map((id) => formatKey(id))));

  const invalidateLatest = (id: number | string): TE.TaskEither<APIError, void> =>
    convertTaskEither(baseInvalidation.invalidateOne(`${parseId(id)}_latest`));

  const invalidateAll = (): TE.TaskEither<APIError, void> =>
    convertTaskEither(baseInvalidation.invalidateOne('all'));

  return {
    invalidateOne,
    invalidateMany,
    invalidateLatest,
    invalidateAll,
  };
};
