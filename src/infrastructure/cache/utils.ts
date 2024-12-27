import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as IO from 'fp-ts/IO';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../http/common/errors';
import { createDatabaseError } from '../http/common/errors';
import { logger } from '../logger/logger';
import {
  APIErrorTransformer,
  CacheError,
  CacheErrorCreator,
  CacheErrorTransformer,
  CacheErrorType,
  CodecValidator,
  LogError,
  LogInfo,
  RedisClient,
} from './types';

/**
 * Error handling utilities
 */
export const createCacheError: CacheErrorCreator = (type, message, cause) => ({
  type,
  message,
  cause,
});

export const toCacheError: (type: CacheErrorType) => CacheErrorTransformer =
  (type) => (message, cause) =>
    createCacheError(type, message, cause);

export const toAPIError: APIErrorTransformer = (error) =>
  createDatabaseError({ message: error.message, details: { error } });

export const mapCacheError = flow(toCacheError(CacheErrorType.OPERATION), toAPIError);

/**
 * Logging utilities
 */
const createLogInfo =
  (message: string): IO.IO<void> =>
  () =>
    logger.info({ message } satisfies LogInfo)();

const createLogError =
  (error: CacheError): IO.IO<void> =>
  () =>
    logger.error({
      message: error.message,
      context: { type: error.type, cause: error.cause },
    } satisfies LogError)();

export const logCacheInfo = (message: string): TE.TaskEither<CacheError, void> =>
  pipe(createLogInfo(message), TE.fromIO, TE.mapLeft(toCacheError(CacheErrorType.OPERATION)));

export const logCacheError = (error: CacheError): TE.TaskEither<CacheError, void> =>
  pipe(createLogError(error), TE.fromIO, TE.mapLeft(toCacheError(CacheErrorType.OPERATION)));

/**
 * Client validation utilities
 */
export const ensureRedisClient = (
  client: RedisClient | undefined,
): E.Either<CacheError, RedisClient> =>
  pipe(
    client,
    E.fromNullable(toCacheError(CacheErrorType.CONNECTION)('Redis client not initialized')),
  );

/**
 * Async operation utilities
 */
export const tryCatchWithContext = <T>(
  operation: () => Promise<T>,
  errorMessage: string,
): TE.TaskEither<APIError, T> =>
  pipe(
    TE.tryCatch(
      operation,
      flow(
        (error: unknown) => toCacheError(CacheErrorType.OPERATION)(errorMessage, error),
        toAPIError,
      ),
    ),
  );

/**
 * Data transformation and validation utilities
 */
export const validateWithCodec = <T>(
  codec: CodecValidator<T>,
  data: unknown,
  errorMessage: string,
): TE.TaskEither<APIError, T> =>
  pipe(
    data,
    codec.decode,
    E.mapLeft(
      flow((error) => toCacheError(CacheErrorType.OPERATION)(errorMessage, error), toAPIError),
    ),
    TE.fromEither,
  );

const serializeData = <T>(data: T): TE.TaskEither<APIError, string> =>
  pipe(
    TE.tryCatch(
      () => Promise.resolve(JSON.stringify(data)),
      flow(
        (error) => toCacheError(CacheErrorType.OPERATION)('Failed to serialize data', error),
        toAPIError,
      ),
    ),
  );

const parseData = (serialized: string): TE.TaskEither<APIError, unknown> =>
  pipe(
    TE.tryCatch(
      () => Promise.resolve(JSON.parse(serialized)),
      flow(
        (error) => toCacheError(CacheErrorType.OPERATION)('Failed to parse data', error),
        toAPIError,
      ),
    ),
  );

export const processData = <T>(
  data: T,
  validateFn: (u: unknown) => TE.TaskEither<APIError, T>,
): TE.TaskEither<APIError, T> =>
  pipe(data, serializeData, TE.chain(parseData), TE.chain(validateFn));
