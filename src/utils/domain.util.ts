// Domain Utility Module
// Utility functions for domain layer operations.

import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import {
  APIError,
  APIErrorCode,
  CacheError,
  DomainError,
  DomainErrorCode,
  createAPIError,
  createDomainError,
} from '../types/errors.type';
import { dbErrorToApiErrorCode, isDBError } from './prisma.util';

/**
 * Creates a domain error with consistent formatting
 */
export const createStandardDomainError = (params: {
  code: DomainErrorCode;
  message: string;
  details?: unknown;
}): DomainError =>
  createDomainError({
    code: params.code,
    message: params.message,
    details: params.details,
  });

/**
 * Converts any error to an API error
 * Handles specific error types (DBError, Error) appropriately
 */
export const toAPIError = (error: unknown): APIError => {
  if (isDBError(error)) {
    return createAPIError({
      code: dbErrorToApiErrorCode[error.code],
      message: error.message,
      details: error.details,
      cause: error.cause,
    });
  }
  if (error instanceof Error) {
    return createAPIError({
      code: APIErrorCode.INTERNAL_SERVER_ERROR,
      message: error.message,
      cause: error,
    });
  }
  return createAPIError({
    code: APIErrorCode.INTERNAL_SERVER_ERROR,
    message: 'An unknown error occurred',
  });
};

/**
 * Validates a domain model
 */
export const validateDomainModel = <T>(
  model: T | null,
  modelName: string,
): E.Either<APIError, T | null> =>
  pipe(
    model,
    E.fromNullable(
      createAPIError({
        code: APIErrorCode.NOT_FOUND,
        message: `${modelName} not found`,
      }),
    ),
  );

// Domain operation error interface
export interface DomainOperationError {
  readonly message: string;
  readonly cause?: unknown;
}

// Creates domain operations utilities
export const createDomainOperations = <D, P>({
  toDomain,
  toPrisma,
}: {
  toDomain: (data: P) => E.Either<string, D>;
  toPrisma: (data: D) => Omit<P, 'createdAt'>;
}) => ({
  single: {
    toDomain: (data: P | null): TE.TaskEither<DomainError, D | null> =>
      data
        ? pipe(
            toDomain(data),
            E.mapLeft((error) =>
              createStandardDomainError({
                code: DomainErrorCode.VALIDATION_ERROR,
                message: error,
              }),
            ),
            TE.fromEither,
          )
        : TE.of(null),
    fromDomain: toPrisma,
  },
  array: {
    toDomain: (data: readonly P[]): TE.TaskEither<DomainError, readonly D[]> =>
      pipe(
        data,
        TE.traverseArray((item) =>
          pipe(
            toDomain(item),
            E.mapLeft((error) =>
              createStandardDomainError({
                code: DomainErrorCode.VALIDATION_ERROR,
                message: error,
              }),
            ),
            TE.fromEither,
          ),
        ),
      ),
    fromDomain: (data: readonly D[]): Omit<P, 'createdAt'>[] => Array.from(data.map(toPrisma)),
  },
});

// Creates a safe cache operation that handles null values
export const createSafeCacheOperation =
  <T>(
    cacheOperation: (item: T) => TE.TaskEither<CacheError, void>,
  ): ((item: T | null) => TE.TaskEither<CacheError, void>) =>
  (item: T | null) =>
    item ? cacheOperation(item) : TE.right(undefined);

// Returns the value if defined
export const getDefinedValue = <T>(value: T | undefined): T | undefined =>
  value !== undefined ? value : undefined;
