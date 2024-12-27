import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { getApiLogger } from '../../logger';
import {
  CacheError,
  CacheErrorType,
  CacheItem,
  CacheOperations,
  CacheWarmerOperations,
  DataProvider,
  DomainType,
  DefaultWarmingConfig as WarmingConfig,
} from '../types';

// Helper functions
const createError = (type: CacheErrorType, message: string, cause?: unknown): CacheError => ({
  type,
  message,
  cause,
});

// Core warmer operations factory
export const createWarmerOperations = (
  cache: CacheOperations,
  dataProviders: readonly DataProvider<CacheItem>[],
): CacheWarmerOperations => {
  const warmDomain = <T extends CacheItem>(
    provider: DataProvider<T>,
  ): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => provider.getData(),
        (error) =>
          createError(
            CacheErrorType.WARMING,
            `Failed to fetch data for domain: ${provider.getDomain()}`,
            error,
          ),
      ),
      TE.chain((data) => processBatch(data, provider.getDomain(), 0)),
    );

  const processBatch = <T extends CacheItem>(
    data: readonly T[],
    domain: DomainType,
    startIndex: number,
  ): TE.TaskEither<CacheError, void> => {
    const batch = data.slice(startIndex, startIndex + WarmingConfig.batchSize);

    if (batch.length === 0) {
      return TE.right(undefined);
    }

    return pipe(
      processBatchItems(batch, domain),
      TE.chain(() => processBatch(data, domain, startIndex + WarmingConfig.batchSize)),
    );
  };

  const processBatchItems = <T extends CacheItem>(
    items: readonly T[],
    domain: DomainType,
  ): TE.TaskEither<CacheError, void> =>
    pipe(
      Array.from(items),
      A.traverse(TE.ApplicativePar)((item) => cache.set(domain, item.id, item)),
      TE.map(() => undefined),
    );

  const warmCache = (): TE.TaskEither<CacheError, void> =>
    pipe(
      Array.from(dataProviders),
      A.traverse(TE.ApplicativePar)(warmDomain),
      TE.map(() => undefined),
    );

  const schedulePeriodicRefresh = (): TE.TaskEither<CacheError, void> => {
    const logger = getApiLogger();

    return pipe(
      TE.fromIO(() => {
        setInterval(() => {
          pipe(
            warmCache(),
            TE.mapLeft((error) =>
              logger.error({
                message: 'Periodic cache refresh failed',
                context: { error },
              }),
            ),
          )();
        }, WarmingConfig.periodicRefreshInterval);
      }),
    );
  };

  const verifyDomainIntegrity = <T extends CacheItem>(
    provider: DataProvider<T>,
  ): TE.TaskEither<CacheError, boolean> =>
    pipe(
      TE.tryCatch(
        () => provider.getData(),
        (error) =>
          createError(
            CacheErrorType.WARMING,
            `Failed to fetch data for integrity check: ${provider.getDomain()}`,
            error,
          ),
      ),
      TE.chain((data) =>
        pipe(
          Array.from(data),
          A.traverse(TE.ApplicativePar)((item) => cache.get(provider.getDomain(), item.id)),
          TE.map((cachedItems) => cachedItems.every(O.isSome)),
        ),
      ),
    );

  const initialize = (): TE.TaskEither<CacheError, void> =>
    pipe(
      warmCache(),
      TE.chain(() => schedulePeriodicRefresh()),
    );

  const verifyIntegrity = (): TE.TaskEither<CacheError, boolean> =>
    pipe(
      Array.from(dataProviders),
      A.traverse(TE.ApplicativePar)(verifyDomainIntegrity),
      TE.map((results) => results.every((result) => result)),
    );

  return {
    initialize,
    verifyIntegrity,
  };
};

// Export factory function
export const createWarmer = (
  cache: CacheOperations,
  dataProviders: readonly DataProvider<CacheItem>[],
): CacheWarmerOperations => createWarmerOperations(cache, dataProviders);
