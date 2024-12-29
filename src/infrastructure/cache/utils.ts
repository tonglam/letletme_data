/**
 * Cache Utilities Module
 *
 * Utility functions for cache operations and error handling.
 */

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { APIError, createInternalServerError } from '../http/common/errors';
import { CacheError, CacheErrorType } from './types';

/**
 * Converts unknown errors to CacheError
 */
const toCacheError = (error: unknown): CacheError => ({
  type: CacheErrorType.OPERATION,
  message: String(error),
});

/**
 * Converts CacheError to APIError
 */
const toAPIError = (error: CacheError): APIError =>
  createInternalServerError({ message: error.message });

/**
 * Implements cache-aside pattern with fallback
 */
export const withCache = <T>(
  getCacheData: () => TE.TaskEither<CacheError, readonly T[]>,
  getRepositoryData: () => TE.TaskEither<unknown, readonly T[]>,
  cacheData: (data: readonly T[]) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, readonly T[]> =>
  pipe(
    getCacheData(),
    TE.mapLeft(toAPIError),
    TE.chain((cachedData) =>
      cachedData.length > 0
        ? TE.right(cachedData)
        : pipe(
            getRepositoryData(),
            TE.mapLeft((error) => toAPIError(toCacheError(error))),
            TE.chain((data) =>
              pipe(
                cacheData(data),
                TE.mapLeft(toAPIError),
                TE.map(() => data),
              ),
            ),
          ),
    ),
  );

/**
 * Implements cache-aside pattern for single items
 */
export const withCacheSingle = <T>(
  getCacheData: () => TE.TaskEither<CacheError, T | null>,
  getRepositoryData: () => TE.TaskEither<unknown, T | null>,
  cacheData: (data: T) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, T | null> =>
  pipe(
    getCacheData(),
    TE.mapLeft(toAPIError),
    TE.chain((cachedData) =>
      cachedData
        ? TE.right(cachedData)
        : pipe(
            getRepositoryData(),
            TE.mapLeft((error) => toAPIError(toCacheError(error))),
            TE.chain((data) =>
              data
                ? pipe(
                    cacheData(data),
                    TE.mapLeft(toAPIError),
                    TE.map(() => data),
                  )
                : TE.right(null),
            ),
          ),
    ),
  );

/**
 * Handles create operations with cache updates
 */
export const withCreate = <T>(
  saveData: () => TE.TaskEither<unknown, T>,
  cacheData: (data: T) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, T> =>
  pipe(
    saveData(),
    TE.mapLeft((error) => toAPIError(toCacheError(error))),
    TE.chain((saved) =>
      pipe(
        cacheData(saved),
        TE.mapLeft(toAPIError),
        TE.map(() => saved),
      ),
    ),
  );

/**
 * Handles batch create operations with cache updates
 */
export const withCreateBatch = <T>(
  saveData: () => TE.TaskEither<unknown, readonly T[]>,
  cacheData: (data: readonly T[]) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, readonly T[]> =>
  pipe(
    saveData(),
    TE.mapLeft((error) => toAPIError(toCacheError(error))),
    TE.chain((saved) =>
      pipe(
        cacheData(saved),
        TE.mapLeft(toAPIError),
        TE.map(() => saved),
      ),
    ),
  );

/**
 * Implements validation before cache operations
 */
export const withValidatedCache =
  <I, V, T>(
    validate: (input: I) => E.Either<string, V>,
    getCacheData: (validated: V) => TE.TaskEither<CacheError, T | null>,
    getRepositoryData: (validated: V) => TE.TaskEither<unknown, T | null>,
    cacheData: (data: T) => TE.TaskEither<CacheError, void>,
  ): ((input: I) => TE.TaskEither<APIError, T | null>) =>
  (input) =>
    pipe(
      validate(input),
      E.mapLeft((message) => toAPIError(toCacheError(message))),
      TE.fromEither,
      TE.chain((validated) =>
        withCacheSingle(
          () => getCacheData(validated),
          () => getRepositoryData(validated),
          cacheData,
        ),
      ),
    );
