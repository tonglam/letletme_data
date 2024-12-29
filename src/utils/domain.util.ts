// Domain Utility Module
// Utility functions for domain layer operations.

import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError, APIErrorCode, createAPIError } from '../types/errors.type';

// Converts any error to an API error
export const toAPIError = (error: unknown): APIError => {
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

// Converts a domain error to a TaskEither
export const toDomainError = <T>(error: Error): TE.TaskEither<APIError, T> =>
  TE.left(toAPIError(error));

// Validates a domain model
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

// Domain error interface
export interface DomainError {
  readonly message: string;
  readonly cause?: unknown;
}

// Creates domain operations utilities
export const createDomainOperations = <D, P, E extends DomainError = DomainError>({
  toDomain,
  toPrisma,
  createError,
}: {
  toDomain: (data: P) => E.Either<string, D>;
  toPrisma: (data: D) => Omit<P, 'createdAt'>;
  createError: (message: string, cause?: unknown) => E;
}) => ({
  single: {
    toDomain: (data: P | null): TE.TaskEither<E, D | null> =>
      data
        ? pipe(
            toDomain(data),
            E.mapLeft((error) => createError(error)),
            TE.fromEither,
          )
        : TE.of(null),
    fromDomain: toPrisma,
  },
  array: {
    toDomain: (data: readonly P[]): TE.TaskEither<E, readonly D[]> =>
      pipe(
        data,
        TE.traverseArray((item) =>
          pipe(
            toDomain(item),
            E.mapLeft((error) => createError(error)),
            TE.fromEither,
          ),
        ),
      ),
    fromDomain: (data: readonly D[]): Omit<P, 'createdAt'>[] => Array.from(data.map(toPrisma)),
  },
});

// Returns the value if defined
export const getDefinedValue = <T>(value: T | undefined): T | undefined =>
  value !== undefined ? value : undefined;
