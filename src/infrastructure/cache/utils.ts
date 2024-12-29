/**
 * Cache Utilities Module
 *
 * Provides utility functions for cache operations and key management.
 * Implements common patterns and helper functions used across the cache infrastructure.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError, APIErrorCode, createAPIError } from '../../types/errors.type';
import { CacheError } from './types';

/**
 * Converts cache error to API error
 */
const toCacheError = (error: CacheError): APIError =>
  createAPIError({
    code: APIErrorCode.INTERNAL_SERVER_ERROR,
    message: error.message,
    details: error,
  });

/**
 * Generic cache operation with validation and fallback
 */
export const withCache = <T>(
  getCached: () => TE.TaskEither<CacheError, readonly T[]>,
  getFresh: () => TE.TaskEither<APIError, readonly T[]>,
  setCache: (data: readonly T[]) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, readonly T[]> =>
  pipe(
    getCached(),
    TE.mapLeft(toCacheError),
    TE.chain((cached) =>
      cached.length > 0
        ? TE.right(cached)
        : pipe(
            getFresh(),
            TE.chain((fresh) =>
              pipe(
                setCache(fresh),
                TE.mapLeft(toCacheError),
                TE.map(() => fresh),
              ),
            ),
          ),
    ),
  );

/**
 * Generic single item cache operation with validation and fallback
 */
export const withCacheSingle = <T>(
  getCached: () => TE.TaskEither<CacheError, T | null>,
  getFresh: () => TE.TaskEither<APIError, T | null>,
  setCache: (data: T | null) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, T | null> =>
  pipe(
    getCached(),
    TE.mapLeft(toCacheError),
    TE.chain((cached) =>
      cached
        ? TE.right(cached)
        : pipe(
            getFresh(),
            TE.chain((fresh) =>
              pipe(
                setCache(fresh),
                TE.mapLeft(toCacheError),
                TE.map(() => fresh),
              ),
            ),
          ),
    ),
  );

/**
 * Generic cache operation with validation
 */
export const withValidatedCache =
  <T, V>(
    validate: (value: string) => TE.TaskEither<string, V>,
    getCached: (validValue: V) => TE.TaskEither<CacheError, T | null>,
    getFresh: (validValue: V) => TE.TaskEither<APIError, T | null>,
    setCache: (data: T | null) => TE.TaskEither<CacheError, void>,
  ): ((value: string) => TE.TaskEither<APIError, T | null>) =>
  (value) =>
    pipe(
      validate(value),
      TE.mapLeft((msg) => createAPIError({ code: APIErrorCode.VALIDATION_ERROR, message: msg })),
      TE.chain((validValue) =>
        pipe(
          getCached(validValue),
          TE.mapLeft(toCacheError),
          TE.chain((cached) =>
            cached
              ? TE.right(cached)
              : pipe(
                  getFresh(validValue),
                  TE.chain((fresh) =>
                    pipe(
                      setCache(fresh),
                      TE.mapLeft(toCacheError),
                      TE.map(() => fresh),
                    ),
                  ),
                ),
          ),
        ),
      ),
    );

/**
 * Generic create operation with cache update
 */
export const withCreate = <T>(
  create: () => TE.TaskEither<APIError, T>,
  setCache: (data: T) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, T> =>
  pipe(
    create(),
    TE.chain((created) =>
      pipe(
        setCache(created),
        TE.mapLeft(toCacheError),
        TE.map(() => created),
      ),
    ),
  );

/**
 * Generic batch create operation with cache update
 */
export const withCreateBatch = <T>(
  createBatch: () => TE.TaskEither<APIError, readonly T[]>,
  setCache: (data: readonly T[]) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, readonly T[]> =>
  pipe(
    createBatch(),
    TE.chain((created) =>
      pipe(
        setCache(created),
        TE.mapLeft(toCacheError),
        TE.map(() => created),
      ),
    ),
  );
