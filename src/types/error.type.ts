// Base error types
export interface ErrorDetails {
  [key: string]: unknown;
}

export interface BaseError {
  readonly name: string;
  readonly message: string;
  readonly code: string;
  readonly timestamp: Date;
  readonly stack?: string;
  readonly cause?: Error;
  readonly details?: ErrorDetails;
}

/**
 * DB Error Types
 */
export enum DBErrorCode {
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  QUERY_ERROR = 'QUERY_ERROR',
  CONSTRAINT_ERROR = 'CONSTRAINT_ERROR',
  OPERATION_ERROR = 'OPERATION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TRANSFORMATION_ERROR = 'TRANSFORMATION_ERROR',
}

export interface DBError extends BaseError {
  readonly code: DBErrorCode;
}

export const createDBError = (params: {
  code: DBErrorCode;
  message: string;
  cause?: Error;
  details?: ErrorDetails;
}): DBError => ({
  name: 'DBError',
  stack: new Error().stack,
  timestamp: new Date(),
  ...params,
});

/**
 * Cache Error Types
 */
export enum CacheErrorCode {
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  OPERATION_ERROR = 'OPERATION_ERROR',
  SERIALIZATION_ERROR = 'SERIALIZATION_ERROR',
  DESERIALIZATION_ERROR = 'DESERIALIZATION_ERROR',
}

export interface CacheError extends BaseError {
  readonly code: CacheErrorCode;
}

export const createCacheError = (params: {
  code: CacheErrorCode;
  message: string;
  cause?: Error;
  details?: ErrorDetails;
}): CacheError => ({
  name: 'CacheError',
  stack: new Error().stack,
  timestamp: new Date(),
  ...params,
});

/**
 * Domain Error Types
 */
export enum DomainErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  PROCESSING_ERROR = 'PROCESSING_ERROR',
}

export interface DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: unknown;
  readonly cause?: Error;
}

export const createDomainError = (params: {
  code: DomainErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): DomainError => ({
  name: 'DomainError',
  stack: new Error().stack,
  ...params,
});

/**
 * API Error Types
 */
export enum APIErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  SERVICE_ERROR = 'SERVICE_ERROR',
}

export interface APIError extends BaseError {
  readonly code: APIErrorCode;
}

export interface APIErrorResponse {
  readonly error: {
    readonly code: APIErrorCode;
    readonly message: string;
  };
}

export const createAPIError = (params: {
  code: APIErrorCode;
  message: string;
  cause?: Error;
  details?: ErrorDetails;
}): APIError => ({
  name: 'APIError',
  stack: params.cause?.stack || undefined,
  timestamp: new Date(),
  ...params,
});

export const formatErrorResponse = (error: APIError) => ({
  error: {
    code: error.code,
    message: error.message,
  },
});

export const getErrorStatus = (error: APIError): number => {
  switch (error.code) {
    case APIErrorCode.VALIDATION_ERROR:
      return 400;
    case APIErrorCode.NOT_FOUND:
      return 404;
    case APIErrorCode.SERVICE_ERROR:
      return 503;
    default:
      return 500;
  }
};

/**
 * Queue Error Types
 */
export enum QueueErrorCode {
  // Queue errors
  CREATE_QUEUE = 'CREATE_QUEUE',
  ADD_JOB = 'ADD_JOB',
  REMOVE_JOB = 'REMOVE_JOB',
  PAUSE_QUEUE = 'PAUSE_QUEUE',
  RESUME_QUEUE = 'RESUME_QUEUE',
  INVALID_JOB_DATA = 'INVALID_JOB_DATA',

  // Worker errors
  CREATE_WORKER = 'CREATE_WORKER',
  START_WORKER = 'START_WORKER',
  STOP_WORKER = 'STOP_WORKER',
  PROCESSING_ERROR = 'PROCESSING_ERROR',

  // Flow errors
  GET_FLOW_DEPENDENCIES = 'GET_FLOW_DEPENDENCIES',
  GET_CHILDREN_VALUES = 'GET_CHILDREN_VALUES',

  // Scheduler errors
  CREATE_JOB_SCHEDULER = 'CREATE_JOB_SCHEDULER',
  GET_JOB_SCHEDULERS = 'GET_JOB_SCHEDULERS',
}

export interface QueueError {
  code: QueueErrorCode;
  context: string;
  error: Error;
}

export const createQueueError = (
  code: QueueErrorCode,
  context: string,
  error: Error,
): QueueError => ({
  code,
  context,
  error,
});

/**
 * Service Error Types
 */
export enum ServiceErrorCode {
  INTEGRATION_ERROR = 'INTEGRATION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  OPERATION_ERROR = 'OPERATION_ERROR',
  TRANSFORMATION_ERROR = 'TRANSFORMATION_ERROR',
}

export interface ServiceError extends BaseError {
  readonly code: ServiceErrorCode;
}

export const createServiceError = (params: {
  code: ServiceErrorCode;
  message: string;
  cause?: Error;
  details?: ErrorDetails;
}): ServiceError => ({
  name: 'ServiceError',
  stack: new Error().stack,
  timestamp: new Date(),
  ...params,
});
