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

export interface APIError extends Error {
  readonly code: APIErrorCode;
  readonly message: string;
  readonly cause?: Error;
  readonly details?: ErrorDetails;
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
  stack: new Error().stack,
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
    default:
      return 500;
  }
};

/**
 * Queue Error Types
 */
export enum QueueErrorCode {
  QUEUE_CONNECTION_ERROR = 'QUEUE_CONNECTION_ERROR',
  QUEUE_INITIALIZATION_ERROR = 'QUEUE_INITIALIZATION_ERROR',
  WORKER_START_ERROR = 'WORKER_START_ERROR',
  WORKER_STOP_ERROR = 'WORKER_STOP_ERROR',
  JOB_PROCESSING_ERROR = 'JOB_PROCESSING_ERROR',
  INVALID_JOB_DATA = 'INVALID_JOB_DATA',
  REMOVE_JOB = 'REMOVE_JOB',
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  START_WORKER = 'START_WORKER',
  CREATE_QUEUE = 'CREATE_QUEUE',
  ADD_JOB = 'ADD_JOB',
  STOP_WORKER = 'STOP_WORKER',
  CREATE_WORKER = 'CREATE_WORKER',
  CLOSE_WORKER = 'CLOSE_WORKER',
  PAUSE_QUEUE = 'PAUSE_QUEUE',
  RESUME_QUEUE = 'RESUME_QUEUE',
  PAUSE_WORKER = 'PAUSE_WORKER',
  RESUME_WORKER = 'RESUME_WORKER',
  UPSERT_JOB_SCHEDULER = 'UPSERT_JOB_SCHEDULER',
  REMOVE_JOB_SCHEDULER = 'REMOVE_JOB_SCHEDULER',
  GET_JOB_SCHEDULER = 'GET_JOB_SCHEDULER',
  ADD_FLOW = 'ADD_FLOW',
  ADD_BULK_FLOWS = 'ADD_BULK_FLOWS',
  REMOVE_FLOW = 'REMOVE_FLOW',
  REMOVE_BULK_FLOWS = 'REMOVE_BULK_FLOWS',
  GET_FLOW_DEPENDENCIES = 'GET_FLOW_DEPENDENCIES',
  GET_CHILDREN_VALUES = 'GET_CHILDREN_VALUES',
}

export interface QueueError {
  readonly type: 'QUEUE_ERROR';
  readonly code: QueueErrorCode;
  readonly message: string;
  readonly queueName: string;
  readonly cause?: Error;
}

export const createQueueError = (
  code: QueueErrorCode,
  queueName: string,
  error: Error,
): QueueError => ({
  type: 'QUEUE_ERROR',
  code,
  message: error.message,
  queueName,
  cause: error,
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
