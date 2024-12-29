// Error utility functions

import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';
import {
  APIError,
  APIErrorCode,
  CacheError,
  CacheErrorCode,
  createAPIError,
  createCacheError,
  createDBError,
  createServiceError,
  DBError,
  DBErrorCode,
  ServiceError,
  ServiceErrorCode,
} from '../types/errors.type';

// ============ API Error Handlers ============

/**
 * Creates a Not Found error
 */
export const handleNotFound = (message: string): APIError =>
  createAPIError({
    code: APIErrorCode.NOT_FOUND,
    message,
  });

/**
 * Handles nullable values by converting them to Either
 */
export const handleNullable =
  <T>(message: string): ((value: T | null) => E.Either<APIError, T>) =>
  (value: T | null) =>
    value === null ? E.left(handleNotFound(message)) : E.right(value);

// ============ Database Error Handlers ============

/**
 * Creates a database operation error
 * Used for general CRUD operation failures
 */
export const createDatabaseOperationError = (error: unknown): DBError => {
  const message = error instanceof Error ? error.message : 'Database operation failed';
  return createDBError({
    code: DBErrorCode.OPERATION_ERROR,
    message,
    details: error,
  });
};

/**
 * Creates a database validation error
 * Used for constraint violations and invalid data
 */
export const createDatabaseValidationError = (error: unknown): DBError => {
  const message = error instanceof Error ? error.message : 'Database validation failed';
  return createDBError({
    code: DBErrorCode.VALIDATION_ERROR,
    message,
    details: error,
  });
};

/**
 * Creates a database transformation error
 * Used for JSON serialization/deserialization failures
 */
export const createDatabaseTransformationError = (error: unknown): DBError => {
  const message = error instanceof Error ? error.message : 'Failed to transform database data';
  return createDBError({
    code: DBErrorCode.TRANSFORMATION_ERROR,
    message,
    details: error,
  });
};

/**
 * Creates a database connection error
 * Used for database connectivity issues
 */
export const createDatabaseConnectionError = (error: unknown): DBError => {
  const message = error instanceof Error ? error.message : 'Failed to connect to database';
  return createDBError({
    code: DBErrorCode.CONNECTION_ERROR,
    message,
    details: error,
  });
};

/**
 * Handles Prisma errors and converts them to appropriate DBError types
 * Preserves original error messages and details for debugging
 */
export const handlePrismaError = (error: unknown): DBError =>
  pipe(
    error,
    // Handle Prisma validation errors
    O.fromPredicate(
      (e): e is Prisma.PrismaClientValidationError =>
        e instanceof Prisma.PrismaClientValidationError,
    ),
    O.map(createDatabaseValidationError),
    O.alt(() =>
      pipe(
        error,
        O.fromPredicate(
          (e): e is Prisma.PrismaClientKnownRequestError =>
            e instanceof Prisma.PrismaClientKnownRequestError,
        ),
        O.map((err) => {
          switch (err.code) {
            case 'P2002':
              return createDatabaseValidationError({
                message: `Unique constraint violation on ${(err.meta?.target as string[])?.join(', ')}`,
                details: err,
              });
            case 'P2003':
              return createDatabaseValidationError({
                message: `Foreign key constraint failed on ${err.meta?.field_name}`,
                details: err,
              });
            case 'P2025':
              return createDatabaseOperationError({
                message: err.message,
                details: err,
              });
            case 'P2011':
              return createDatabaseValidationError({
                message: `Null constraint violation on ${err.meta?.target}`,
                details: err,
              });
            case 'P2006':
              return createDatabaseTransformationError({
                message: `Invalid data type for ${err.meta?.target}`,
                details: err,
              });
            default:
              return createDatabaseOperationError(err);
          }
        }),
      ),
    ),
    O.alt(() =>
      pipe(
        error,
        O.fromPredicate(
          (e): e is Prisma.PrismaClientInitializationError =>
            e instanceof Prisma.PrismaClientInitializationError,
        ),
        O.map(createDatabaseConnectionError),
      ),
    ),
    O.alt(() =>
      pipe(
        error,
        O.fromPredicate(
          (e): e is Prisma.PrismaClientRustPanicError =>
            e instanceof Prisma.PrismaClientRustPanicError,
        ),
        O.map(createDatabaseConnectionError),
      ),
    ),
    O.alt(() =>
      pipe(
        error,
        O.fromPredicate(
          (e): e is Prisma.PrismaClientUnknownRequestError =>
            e instanceof Prisma.PrismaClientUnknownRequestError,
        ),
        O.map(createDatabaseOperationError),
      ),
    ),
    O.getOrElse(() => createDatabaseOperationError(error)),
  );

// ============ Cache Error Handlers ============

/**
 * Creates a cache connection error
 * Used for cache connectivity issues
 */
export const createCacheConnectionError = (error: unknown): CacheError => {
  const message = error instanceof Error ? error.message : 'Failed to connect to cache';
  return createCacheError({
    code: CacheErrorCode.CONNECTION_ERROR,
    message,
    details: error,
  });
};

/**
 * Creates a cache operation error
 * Used for general cache operation failures
 */
export const createCacheOperationError = (error: unknown): CacheError => {
  const message = error instanceof Error ? error.message : 'Cache operation failed';
  return createCacheError({
    code: CacheErrorCode.OPERATION_ERROR,
    message,
    details: error,
  });
};

/**
 * Creates a cache serialization error
 * Used for data serialization failures
 */
export const createCacheSerializationError = (error: unknown): CacheError => {
  const message = error instanceof Error ? error.message : 'Failed to serialize cache data';
  return createCacheError({
    code: CacheErrorCode.SERIALIZATION_ERROR,
    message,
    details: error,
  });
};

/**
 * Creates a cache deserialization error
 * Used for data deserialization failures
 */
export const createCacheDeserializationError = (error: unknown): CacheError => {
  const message = error instanceof Error ? error.message : 'Failed to deserialize cache data';
  return createCacheError({
    code: CacheErrorCode.DESERIALIZATION_ERROR,
    message,
    details: error,
  });
};

// ============ Service Error Handlers ============

/**
 * Creates a service operation error
 * Used for general service operation failures
 */
export const createServiceOperationError = (error: unknown): ServiceError => {
  const message = error instanceof Error ? error.message : 'Service operation failed';
  return createServiceError({
    code: ServiceErrorCode.OPERATION_ERROR,
    message,
    details: error,
  });
};

/**
 * Creates a service validation error
 * Used for service-level validation failures
 */
export const createServiceValidationError = (error: unknown): ServiceError => {
  const message = error instanceof Error ? error.message : 'Service validation failed';
  return createServiceError({
    code: ServiceErrorCode.VALIDATION_ERROR,
    message,
    details: error,
  });
};

/**
 * Creates a service integration error
 * Used for external service integration failures
 */
export const createServiceIntegrationError = (error: unknown): ServiceError => {
  const message = error instanceof Error ? error.message : 'Service integration failed';
  return createServiceError({
    code: ServiceErrorCode.INTEGRATION_ERROR,
    message,
    details: error,
  });
};

/**
 * Creates a service transformation error
 * Used for data transformation failures at service level
 */
export const createServiceTransformationError = (error: unknown): ServiceError => {
  const message = error instanceof Error ? error.message : 'Service transformation failed';
  return createServiceError({
    code: ServiceErrorCode.TRANSFORMATION_ERROR,
    message,
    details: error,
  });
};

// ============ Error Type Conversions ============

/**
 * Maps database error codes to API error codes
 */
const dbErrorToApiErrorCode: Record<DBErrorCode, APIErrorCode> = {
  [DBErrorCode.CONNECTION_ERROR]: APIErrorCode.SERVICE_ERROR,
  [DBErrorCode.OPERATION_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [DBErrorCode.VALIDATION_ERROR]: APIErrorCode.VALIDATION_ERROR,
  [DBErrorCode.TRANSFORMATION_ERROR]: APIErrorCode.BAD_REQUEST,
};

/**
 * Type guard for DBError
 */
const isDBError = (error: unknown): error is DBError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  Object.values(DBErrorCode).includes((error as DBError).code);

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
