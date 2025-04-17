import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { redisClient } from './client';
import { CACHE_CONFIG } from '../../configs/cache/redis.config';
import {
  CacheError,
  CacheErrorCode,
  DomainError,
  DomainErrorCode,
  createDomainError,
} from '../../types/error.type';

const toCacheDomainError = (error: CacheError): DomainError =>
  createDomainError({
    code: DomainErrorCode.VALIDATION_ERROR,
    message: error.message,
    cause: error.cause instanceof Error ? error.cause : new Error(String(error.cause)),
  });

export const createStandardCacheError = (error: unknown, message?: string): CacheError => ({
  name: 'CacheError',
  code: CacheErrorCode.OPERATION_ERROR,
  message: message || String(error),
  cause: error instanceof Error ? error : undefined,
  stack: new Error().stack,
  timestamp: new Date(),
});

export const withCacheErrorHandling = <T>(
  operation: () => Promise<T>,
  errorMessage?: string,
): TE.TaskEither<CacheError, T> =>
  TE.tryCatch(operation, (error) => createStandardCacheError(error, errorMessage));

export const withCache = <T extends NonNullable<unknown>>(
  getCached: () => TE.TaskEither<CacheError, readonly T[]>,
  getSource: () => TE.TaskEither<DomainError, readonly T[]>,
  setCache: (data: readonly T[]) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<DomainError, readonly T[]> =>
  pipe(
    getCached(),
    TE.mapLeft(toCacheDomainError),
    TE.fold(
      () =>
        pipe(
          getSource(),
          TE.chain((data) =>
            pipe(
              setCache(data),
              TE.mapLeft(toCacheDomainError),
              TE.map(() => data),
            ),
          ),
        ),
      TE.right,
    ),
  );

export const withCacheSingle = <T extends NonNullable<unknown>>(
  getCached: () => TE.TaskEither<CacheError, T | null>,
  getSource: () => TE.TaskEither<DomainError, T | null>,
  setCache: (data: T) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<DomainError, T | null> =>
  pipe(
    getCached(),
    TE.mapLeft(toCacheDomainError),
    TE.fold(
      () =>
        pipe(
          getSource(),
          TE.chain((data) =>
            data
              ? pipe(
                  setCache(data),
                  TE.mapLeft(toCacheDomainError),
                  TE.map(() => data),
                )
              : TE.right(null),
          ),
        ),
      TE.right,
    ),
  );

export const withCreate = <T extends NonNullable<unknown>>(
  create: () => TE.TaskEither<DomainError, T>,
  setCache: (data: T) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<DomainError, T> =>
  pipe(
    create(),
    TE.chain((data) =>
      pipe(
        setCache(data),
        TE.mapLeft(toCacheDomainError),
        TE.map(() => data),
      ),
    ),
  );

export const withCreateBatch = <T extends NonNullable<unknown>>(
  createBatch: () => TE.TaskEither<DomainError, readonly T[]>,
  setCache: (data: readonly T[]) => TE.TaskEither<CacheError, void>,
): TE.TaskEither<DomainError, readonly T[]> =>
  pipe(
    createBatch(),
    TE.chain((data) =>
      pipe(
        setCache(data),
        TE.mapLeft(toCacheDomainError),
        TE.map(() => data),
      ),
    ),
  );

export const withValidatedCache =
  <V extends NonNullable<unknown>, T extends NonNullable<unknown>>(
    validate: (value: string) => TE.TaskEither<DomainError, V>,
    getCached: (validValue: V) => TE.TaskEither<CacheError, T | null>,
    getSource: (validValue: V) => TE.TaskEither<DomainError, T | null>,
    setCache: (data: T) => TE.TaskEither<CacheError, void>,
  ) =>
  (value: string): TE.TaskEither<DomainError, T | null> =>
    pipe(
      validate(value),
      TE.chain((validValue) =>
        pipe(
          getCached(validValue),
          TE.mapLeft(toCacheDomainError),
          TE.fold(
            () =>
              pipe(
                getSource(validValue),
                TE.chain((data) =>
                  data
                    ? pipe(
                        setCache(data),
                        TE.mapLeft(toCacheDomainError),
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

export const withPipeline = <T>(
  values: readonly T[],
  operation: (pipeline: ReturnType<typeof redisClient.pipeline>, value: T) => void,
  batchSize: number = CACHE_CONFIG.batchSize,
): TE.TaskEither<CacheError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        for (let i = 0; i < values.length; i += batchSize) {
          const batch = values.slice(i, i + batchSize);
          const pipeline = redisClient.pipeline();
          batch.forEach((value) => operation(pipeline, value));
          await pipeline.exec();
        }
      },
      (error) => createStandardCacheError(error, 'Pipeline operation failed'),
    ),
  );
