// Cache Higher-Order Operations
//
// Provides higher-order functions for common cache patterns
// using functional programming with fp-ts.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError, APIErrorCode, createAPIError } from '../../../types/errors.type';
import { CacheError } from '../types';

// Convert CacheError to APIError
const toCacheAPIError = (error: CacheError): APIError =>
  createAPIError({
    code: APIErrorCode.SERVICE_ERROR,
    message: error.message,
    cause: error.cause instanceof Error ? error.cause : new Error(String(error.cause)),
  });

// Handles cache-aside pattern for collections
export const withCache = <T extends NonNullable<unknown>>(
  getCached: () => TE.TaskEither<CacheError, readonly T[]>,
  getSource: () => TE.TaskEither<APIError, readonly T[]>,
  setCache: (data: readonly T[]) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, readonly T[]> =>
  pipe(
    getCached(),
    TE.mapLeft(toCacheAPIError),
    TE.fold(
      () =>
        pipe(
          getSource(),
          TE.chain((data) =>
            pipe(
              setCache(data),
              TE.mapLeft(toCacheAPIError),
              TE.map(() => data),
            ),
          ),
        ),
      TE.right,
    ),
  );

// Handles cache-aside pattern for single items
export const withCacheSingle = <T extends NonNullable<unknown>>(
  getCached: () => TE.TaskEither<CacheError, T | null>,
  getSource: () => TE.TaskEither<APIError, T | null>,
  setCache: (data: T) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, T | null> =>
  pipe(
    getCached(),
    TE.mapLeft(toCacheAPIError),
    TE.fold(
      () =>
        pipe(
          getSource(),
          TE.chain((data) =>
            data
              ? pipe(
                  setCache(data),
                  TE.mapLeft(toCacheAPIError),
                  TE.map(() => data),
                )
              : TE.right(null),
          ),
        ),
      TE.right,
    ),
  );

// Handles create operations with cache updates
export const withCreate = <T extends NonNullable<unknown>>(
  create: () => TE.TaskEither<APIError, T>,
  setCache: (data: T) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, T> =>
  pipe(
    create(),
    TE.chain((data) =>
      pipe(
        setCache(data),
        TE.mapLeft(toCacheAPIError),
        TE.map(() => data),
      ),
    ),
  );

// Handles batch create operations with cache updates
export const withCreateBatch = <T extends NonNullable<unknown>>(
  createBatch: () => TE.TaskEither<APIError, readonly T[]>,
  setCache: (data: readonly T[]) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<APIError, readonly T[]> =>
  pipe(
    createBatch(),
    TE.chain((data) =>
      pipe(
        setCache(data),
        TE.mapLeft(toCacheAPIError),
        TE.map(() => data),
      ),
    ),
  );

// Handles validated cache operations
export const withValidatedCache =
  <V extends NonNullable<unknown>, T extends NonNullable<unknown>>(
    validate: (value: string) => TE.TaskEither<APIError, V>,
    getCached: (validValue: V) => TE.TaskEither<CacheError, T | null>,
    getSource: (validValue: V) => TE.TaskEither<APIError, T | null>,
    setCache: (data: T) => TE.TaskEither<CacheError, void>,
  ) =>
  (value: string): TE.TaskEither<APIError, T | null> =>
    pipe(
      validate(value),
      TE.chain((validValue) =>
        pipe(
          getCached(validValue),
          TE.mapLeft(toCacheAPIError),
          TE.fold(
            () =>
              pipe(
                getSource(validValue),
                TE.chain((data) =>
                  data
                    ? pipe(
                        setCache(data),
                        TE.mapLeft(toCacheAPIError),
                        TE.map(() => data),
                      )
                    : TE.right(null),
                ),
              ),
            TE.right,
          ),
        ),
      ),
    );
