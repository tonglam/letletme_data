/**
 * Cache Utilities Module
 *
 * Provides utility functions for cache operations and error handling.
 * Implements common cache patterns and error transformations.
 *
 * Features:
 * - Cache-aside pattern implementation
 * - Error transformation utilities
 * - Validation handling
 * - Batch operation support
 * - Functional composition utilities
 *
 * This module provides reusable utilities for implementing
 * cache patterns and handling common cache scenarios.
 */

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { APIError, createInternalServerError } from '../http/common/errors';
import { CacheError, CacheErrorType } from './types';

/**
 * Converts unknown errors to CacheError type.
 * Provides consistent error handling for cache operations.
 *
 * @param error - Unknown error to convert
 * @returns Structured cache error
 */
const toCacheError = (error: unknown): CacheError => ({
  type: CacheErrorType.OPERATION,
  message: String(error),
});

/**
 * Converts CacheError to APIError type.
 * Ensures consistent error reporting in API responses.
 *
 * @param error - Cache error to convert
 * @returns API error representation
 */
const toAPIError = (error: CacheError): APIError =>
  createInternalServerError({ message: error.message });

/**
 * Implements cache-aside pattern with fallback to repository.
 * Handles cache misses and updates cache with repository data.
 *
 * @template T - Type of cached data
 * @param getCacheData - Function to retrieve data from cache
 * @param getRepositoryData - Function to retrieve data from repository
 * @param cacheData - Function to cache repository data
 * @returns TaskEither with data or error
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
 * Implements cache-aside pattern for single item operations.
 * Handles cache misses and updates cache with repository data.
 *
 * @template T - Type of cached data
 * @param getCacheData - Function to retrieve item from cache
 * @param getRepositoryData - Function to retrieve item from repository
 * @param cacheData - Function to cache repository data
 * @returns TaskEither with data or error
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
 * Handles create operations with cache updates.
 * Ensures data consistency between repository and cache.
 *
 * @template T - Type of data to create
 * @param saveData - Function to save data to repository
 * @param cacheData - Function to cache saved data
 * @returns TaskEither with created data or error
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
 * Handles batch create operations with cache updates.
 * Ensures data consistency for multiple items.
 *
 * @template T - Type of data to create
 * @param saveData - Function to save batch data to repository
 * @param cacheData - Function to cache saved data
 * @returns TaskEither with created data or error
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
 * Implements validation before cache operations.
 * Ensures data integrity and type safety.
 *
 * @template I - Input type
 * @template V - Validated type
 * @template T - Result type
 * @param validate - Function to validate input
 * @param getCacheData - Function to retrieve validated data from cache
 * @param getRepositoryData - Function to retrieve validated data from repository
 * @param cacheData - Function to cache validated data
 * @returns Function that processes validated cache operations
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
