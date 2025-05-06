import {
  APIError,
  APIErrorCode,
  CacheError,
  CacheErrorCode,
  createAPIError,
  createCacheError,
  createDBError,
  createDomainError,
  createServiceError,
  DataLayerError,
  DBError,
  DBErrorCode,
  DomainError,
  DomainErrorCode,
  QueueError,
  QueueErrorCode,
  ServiceError,
  ServiceErrorCode,
} from '@app/types/error.types';
import * as E from 'fp-ts/Either';
import { ZodError } from 'zod';

const isQueueError = (error: unknown): error is QueueError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'context' in error &&
  'error' in error;

// ============ Domain Error Handlers ============

export const handleDomainError =
  (message: string) =>
  (error: Error | unknown): DomainError =>
    createDomainError({
      code: DomainErrorCode.DATABASE_ERROR,
      message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
      cause: error instanceof Error ? error : new Error(String(error)),
    });

// ============ API Error Handlers ============

export const handleNotFound = (message: string): APIError =>
  createAPIError({
    code: APIErrorCode.NOT_FOUND,
    message,
  });

export const handleNullable =
  <T>(message: string): ((value: T | null) => E.Either<APIError, T>) =>
  (value: T | null) =>
    value === null ? E.left(handleNotFound(message)) : E.right(value);

// ============ Database Error Handlers ============

export const createDatabaseOperationError = (error: unknown): DBError => {
  const message = error instanceof Error ? error.message : 'Database operation failed';
  return createDBError({
    code: DBErrorCode.OPERATION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

export const createDatabaseValidationError = (error: unknown): DBError => {
  const message = error instanceof Error ? error.message : 'Database validation failed';
  return createDBError({
    code: DBErrorCode.VALIDATION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

export const createDatabaseTransformationError = (error: unknown): DBError => {
  const message = error instanceof Error ? error.message : 'Failed to transform database data';
  return createDBError({
    code: DBErrorCode.TRANSFORMATION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

export const createDatabaseConnectionError = (error: unknown): DBError => {
  const message = error instanceof Error ? error.message : 'Failed to connect to database';
  return createDBError({
    code: DBErrorCode.CONNECTION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

// ============ Cache Error Handlers ============

export const createCacheConnectionError = (error: unknown): CacheError => {
  const message = error instanceof Error ? error.message : 'Failed to connect to cache';
  return createCacheError({
    code: CacheErrorCode.CONNECTION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

export const createCacheOperationError = (error: unknown): CacheError => {
  const message = error instanceof Error ? error.message : 'Cache operation failed';
  return createCacheError({
    code: CacheErrorCode.OPERATION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

export const createCacheSerializationError = (error: unknown): CacheError => {
  const message = error instanceof Error ? error.message : 'Failed to serialize cache data';
  return createCacheError({
    code: CacheErrorCode.SERIALIZATION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

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

export const createServiceOperationError = (error: unknown): ServiceError => {
  const message = error instanceof Error ? error.message : 'Service operation failed';
  return createServiceError({
    code: ServiceErrorCode.INTEGRATION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

export const createServiceValidationError = (error: unknown): ServiceError => {
  const message = error instanceof Error ? error.message : 'Service validation failed';
  return createServiceError({
    code: ServiceErrorCode.VALIDATION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

export const createServiceIntegrationError = (error: unknown): ServiceError => {
  const message = error instanceof Error ? error.message : 'Service integration failed';
  return createServiceError({
    code: ServiceErrorCode.INTEGRATION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

export const createServiceTransformationError = (error: unknown): ServiceError => {
  const message = error instanceof Error ? error.message : 'Service transformation failed';
  return createServiceError({
    code: ServiceErrorCode.INTEGRATION_ERROR,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
    cause: error instanceof Error ? error : undefined,
  });
};

// ============ Queue Error Handlers ============

export const createQueueConnectionError = (params: {
  message: string;
  queueName: string;
  cause?: Error;
}): QueueError => ({
  code: QueueErrorCode.CREATE_QUEUE,
  context: params.queueName,
  error: new Error(params.message, { cause: params.cause }),
});

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

const dbErrorToApiErrorCode: Record<DBErrorCode, APIErrorCode> = {
  [DBErrorCode.CONNECTION_ERROR]: APIErrorCode.SERVICE_ERROR,
  [DBErrorCode.QUERY_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [DBErrorCode.CONSTRAINT_ERROR]: APIErrorCode.VALIDATION_ERROR,
  [DBErrorCode.OPERATION_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [DBErrorCode.VALIDATION_ERROR]: APIErrorCode.VALIDATION_ERROR,
  [DBErrorCode.TRANSFORMATION_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [DBErrorCode.NOT_FOUND]: APIErrorCode.NOT_FOUND,
};

const queueErrorToApiErrorCode: Record<QueueErrorCode, APIErrorCode> = {
  [QueueErrorCode.CREATE_QUEUE]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.INIT_QUEUE]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.ADD_JOB]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.REMOVE_JOB]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.PAUSE_QUEUE]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.RESUME_QUEUE]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.CLOSE_QUEUE]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.INVALID_JOB_DATA]: APIErrorCode.VALIDATION_ERROR,
  [QueueErrorCode.CREATE_WORKER]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.START_WORKER]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.STOP_WORKER]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.PROCESSING_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.GET_FLOW_DEPENDENCIES]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.GET_CHILDREN_VALUES]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.CREATE_JOB_SCHEDULER]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [QueueErrorCode.GET_JOB_SCHEDULERS]: APIErrorCode.INTERNAL_SERVER_ERROR,
};

const isDBError = (error: unknown): error is DBError =>
  typeof error === 'object' &&
  error !== null &&
  '_tag' in error &&
  (error as DBError)._tag === 'DBError';

export const queueErrorToApiError = (error: QueueError): APIError =>
  createAPIError({
    code: queueErrorToApiErrorCode[error.code],
    message: error.error.message,
    details: { context: error.context },
    cause: error.error,
  });

const isServiceError = (error: unknown): error is ServiceError =>
  typeof error === 'object' &&
  error !== null &&
  '_tag' in error &&
  (error as ServiceError)._tag === 'ServiceError';

const serviceErrorToApiErrorCode: Record<ServiceErrorCode, APIErrorCode> = {
  [ServiceErrorCode.INTEGRATION_ERROR]: APIErrorCode.SERVICE_ERROR,
  [ServiceErrorCode.VALIDATION_ERROR]: APIErrorCode.VALIDATION_ERROR,
  [ServiceErrorCode.UNKNOWN]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [ServiceErrorCode.NOT_FOUND]: APIErrorCode.NOT_FOUND,
  [ServiceErrorCode.CACHE_ERROR]: APIErrorCode.SERVICE_ERROR,
  [ServiceErrorCode.DB_ERROR]: APIErrorCode.SERVICE_ERROR,
  [ServiceErrorCode.QUEUE_ERROR]: APIErrorCode.SERVICE_ERROR,
  [ServiceErrorCode.CONFIG_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [ServiceErrorCode.CONDITION_NOT_MET]: APIErrorCode.INTERNAL_SERVER_ERROR,
};

const isDomainError = (error: unknown): error is DomainError =>
  typeof error === 'object' &&
  error !== null &&
  '_tag' in error &&
  (error as DomainError)._tag === 'DomainError';

export const toAPIError = (error: unknown): APIError => {
  // Check underlying cause first if available and it's a known tagged error type
  if (typeof error === 'object' && error !== null && 'cause' in error && error.cause) {
    const cause = error.cause;
    // Check if cause is DBError and NOT_FOUND
    if (isDBError(cause) && cause.code === DBErrorCode.NOT_FOUND) {
      return createAPIError({
        code: APIErrorCode.NOT_FOUND,
        message: (error as Error).message || 'Resource not found due to database lookup failure',
        cause: cause,
      });
    }
    // Check if cause is DomainError and NOT_FOUND
    if (isDomainError(cause) && cause.code === DomainErrorCode.NOT_FOUND) {
      return createAPIError({
        code: APIErrorCode.NOT_FOUND,
        message: (error as Error).message || 'Resource not found due to domain logic failure',
        cause: cause,
      });
    }
  }

  // Now handle the top-level error type
  if (isDBError(error)) {
    // Specific check for top-level DB NOT_FOUND
    if (error.code === DBErrorCode.NOT_FOUND) {
      return createAPIError({
        code: APIErrorCode.NOT_FOUND,
        message: error.message,
        cause: error.cause,
      });
    }
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
    // No need to re-check cause here, already handled above
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

export const mapRepositoryErrorToCacheError =
  (message: string) =>
  (error: DBError): CacheError =>
    createCacheError({
      code: CacheErrorCode.DATA_PROVIDER_ERROR,
      message: `${message}: ${error.message}`,
      cause: error.cause,
    });

export const mapCacheErrorToDomainError = (cacheError: CacheError): DomainError =>
  createDomainError({
    code: DomainErrorCode.CACHE_ERROR,
    message: cacheError.message,
    cause: cacheError.cause,
  });

export const mapDBErrorToServiceError = (error: DBError): ServiceError =>
  createServiceError({
    code: ServiceErrorCode.DB_ERROR,
    message: `Database Error: ${error.message}`,
    cause: error.cause,
    details: error.details,
  });

export const mapDataLayerErrorToServiceError = (error: DataLayerError): ServiceError =>
  createServiceError({
    code: ServiceErrorCode.INTEGRATION_ERROR,
    message: `Data layer error: ${error.message}`,
    cause: error.cause,
    details: error.details,
  });

export const mapCacheErrorToServiceError = (error: CacheError): ServiceError =>
  createServiceError({
    code: ServiceErrorCode.INTEGRATION_ERROR,
    message: `Cache Operation Failed: ${error.message}`,
    cause: error,
  });

// Safely get an error message from any thrown value
export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return 'An unknown error occurred';
  }
};

/**
 * Formats a ZodError into a standard Error object with a user-friendly message.
 *
 * @param error - The ZodError instance.
 * @param context - Optional context string to include in the error message.
 * @returns A standard Error object.
 */
export const formatZodError = (error: ZodError, context?: string): Error => {
  const messages = error.errors
    .map((e) => `${e.path.join('.') || 'value'}: ${e.message}`)
    .join('; ');
  const prefix = context ? `${context}: ` : '';
  return new Error(`${prefix}Validation failed - ${messages}`);
};

// Basic Error Logger (Integrate with your actual logger like Pino)
// You'll want to enhance this significantly for production
export const logError = (error: unknown, context?: Record<string, unknown>): void => {
  // TODO: Replace with actual Pino logger instance
  console.error('--- ERROR ---');
  if (error && typeof error === 'object' && '_tag' in error) {
    // Log structured error
    console.error(JSON.stringify({ error, context }, null, 2));
  } else if (error instanceof Error) {
    console.error(`Message: ${error.message}`);
    if (context) console.error(`Context: ${JSON.stringify(context)}`);
    console.error(`Stack: ${error.stack}`);
  } else {
    console.error(`Unknown Error: ${getErrorMessage(error)}`);
    if (context) console.error(`Context: ${JSON.stringify(context)}`);
  }
  console.error('-------------');
};

// Add other generic utilities as needed
