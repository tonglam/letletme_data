/**
 * Cache Utilities Module
 *
 * Utility functions for cache operations and error handling.
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
 * Validates cached data
 */
export const withValidatedCache = <T>(
  cachedValue: TE.TaskEither<CacheError, T | null>,
  fallback: TE.TaskEither<APIError, T | null>,
): TE.TaskEither<APIError, T | null> =>
  pipe(
    cachedValue,
    TE.mapLeft(toCacheError),
    TE.chain((value) => (value === null ? fallback : TE.right(value))),
  );
