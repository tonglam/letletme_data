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
  DBError,
  DBErrorCode,
  QueueError,
  QueueErrorCode,
  ServiceError,
  ServiceErrorCode,
  createAPIError,
  createCacheError,
  createDBError,
  createServiceError,
} from '../types/error.type';

// Type guard for QueueError
const isQueueError = (error: unknown): error is QueueError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'context' in error &&
  'error' in error;

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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
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
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

// ============ Queue Error Handlers ============

/**
 * Creates a queue connection error
 */
export const createQueueConnectionError = (params: {
  message: string;
  queueName: string;
  cause?: Error;
}): QueueError => ({
  code: QueueErrorCode.CREATE_QUEUE,
  context: params.queueName,
  error: new Error(params.message, { cause: params.cause }),
});

/**
 * Creates a queue processing error
 */
export const createQueueProcessingError = (params: {
  message: string;
  queueName: string;
  cause?: Error;
}): QueueError => ({
  code: QueueErrorCode.PROCESSING_ERROR,
  context: params.queueName,
  error: new Error(params.message, { cause: params.cause }),
});

// ============ Error Type Conversions ============

/**
 * Maps database error codes to API error codes
 */
const dbErrorToApiErrorCode: Record<DBErrorCode, APIErrorCode> = {
  [DBErrorCode.CONNECTION_ERROR]: APIErrorCode.SERVICE_ERROR,
  [DBErrorCode.QUERY_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [DBErrorCode.CONSTRAINT_ERROR]: APIErrorCode.VALIDATION_ERROR,
  [DBErrorCode.OPERATION_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [DBErrorCode.VALIDATION_ERROR]: APIErrorCode.VALIDATION_ERROR,
  [DBErrorCode.TRANSFORMATION_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
};

/**
 * Maps queue error codes to API error codes
 */
const queueErrorToApiErrorCode: Record<QueueErrorCode, APIErrorCode> = {
  [QueueErrorCode.CREATE_QUEUE]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.ADD_JOB]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.REMOVE_JOB]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.PAUSE_QUEUE]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.RESUME_QUEUE]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.INVALID_JOB_DATA]: APIErrorCode.VALIDATION_ERROR,
  [QueueErrorCode.CREATE_WORKER]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.START_WORKER]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.STOP_WORKER]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.PROCESSING_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.GET_FLOW_DEPENDENCIES]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.GET_CHILDREN_VALUES]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.CREATE_JOB_SCHEDULER]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.GET_JOB_SCHEDULERS]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.CLOSE_QUEUE]: APIErrorCode.INTERNAL_SERVER_ERROR,
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
 * Converts queue error to API error
 */
export const queueErrorToApiError = (error: QueueError): APIError => ({
  name: 'APIError',
  code: queueErrorToApiErrorCode[error.code],
  message: error.error.message,
  details: { context: error.context },
  cause: error.error,
  stack: error.error.stack,
  timestamp: new Date(),
});

/**
 * Type guard for ServiceError
 */
const isServiceError = (error: unknown): error is ServiceError =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as ServiceError).name === 'ServiceError' &&
  'code' in error &&
  Object.values(ServiceErrorCode).includes((error as ServiceError).code);

/**
 * Maps service error codes to API error codes
 */
const serviceErrorToApiErrorCode: Record<ServiceErrorCode, APIErrorCode> = {
  [ServiceErrorCode.INTEGRATION_ERROR]: APIErrorCode.SERVICE_ERROR,
  [ServiceErrorCode.VALIDATION_ERROR]: APIErrorCode.VALIDATION_ERROR,
  [ServiceErrorCode.OPERATION_ERROR]: APIErrorCode.SERVICE_ERROR,
  [ServiceErrorCode.TRANSFORMATION_ERROR]: APIErrorCode.SERVICE_ERROR,
};

/**
 * Converts any error to an API error
 * Handles specific error types (DBError, QueueError, ServiceError, Error) appropriately
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
  if (isQueueError(error)) {
    return queueErrorToApiError(error);
  }
  if (isServiceError(error)) {
    return createAPIError({
      code: serviceErrorToApiErrorCode[error.code],
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
