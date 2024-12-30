// Core type definitions for error handling across the application.
// Follows functional programming principles and provides type safety.

// Queue operation types
export enum QueueOperation {
  ADD_JOB = 'addJob',
  REMOVE_JOB = 'removeJob',
  PAUSE_QUEUE = 'pauseQueue',
  RESUME_QUEUE = 'resumeQueue',
  CLEAN_QUEUE = 'cleanQueue',
  CREATE_QUEUE = 'createQueue',
  CREATE_SCHEDULE = 'createSchedule',
  CLEANUP_JOBS = 'cleanupJobs',
  GET_JOB_STATUS = 'getJobStatus',
  GET_QUEUE_METRICS = 'getQueueMetrics',
  PROCESS_JOB = 'processJob',
  VALIDATE_JOB = 'validateJob',
  CONNECT_QUEUE = 'connectQueue',
  TIMEOUT_JOB = 'timeoutJob',
  START_WORKER = 'startWorker',
  STOP_WORKER = 'stopWorker',
  CREATE_WORKER = 'createWorker',
  GET_WORKER = 'getWorker',
  GET_QUEUE = 'getQueue',
}

// Job type enums
export enum LiveJobType {
  LIVE_SCORE = 'LIVE_SCORE',
  LIVE_CACHE = 'LIVE_CACHE',
}

export enum PostMatchJobType {
  MATCH_RESULT = 'MATCH_RESULT',
  PLAYER_STATS = 'PLAYER_STATS',
  TEAM_STATS = 'TEAM_STATS',
}

export enum DailyJobType {
  CLEANUP = 'CLEANUP',
  MAINTENANCE = 'MAINTENANCE',
  REPORT = 'REPORT',
}

export enum JobOperationType {
  UPDATE = 'UPDATE',
  SYNC = 'SYNC',
}

// Queue operation error codes
export enum QueueOperationErrorCode {
  QUEUE_PAUSE_ALL_ERROR = 'QUEUE_PAUSE_ALL_ERROR',
  QUEUE_RESUME_ALL_ERROR = 'QUEUE_RESUME_ALL_ERROR',
  QUEUE_CLEANUP_ALL_ERROR = 'QUEUE_CLEANUP_ALL_ERROR',
  QUEUE_GET_ERROR = 'QUEUE_GET_ERROR',
  QUEUE_INIT_ERROR = 'QUEUE_INIT_ERROR',
  QUEUE_OPERATION_ERROR = 'QUEUE_OPERATION_ERROR',
}

// ============ Error Codes ============

// Queue error codes
export enum QueueErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
}

// API error codes
export const APIErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  SERVICE_ERROR: 'SERVICE_ERROR',
} as const;

export type APIErrorCode = (typeof APIErrorCode)[keyof typeof APIErrorCode];

// Database error codes
export const DBErrorCode = {
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  OPERATION_ERROR: 'OPERATION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TRANSFORMATION_ERROR: 'TRANSFORMATION_ERROR',
} as const;

export type DBErrorCode = (typeof DBErrorCode)[keyof typeof DBErrorCode];

// Cache error codes
export const CacheErrorCode = {
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  SET_ERROR: 'SET_ERROR',
  GET_ERROR: 'GET_ERROR',
  DELETE_ERROR: 'DELETE_ERROR',
  EXISTS_ERROR: 'EXISTS_ERROR',
  TTL_ERROR: 'TTL_ERROR',
  SERIALIZATION_ERROR: 'SERIALIZATION_ERROR',
  DESERIALIZATION_ERROR: 'DESERIALIZATION_ERROR',
  OPERATION_ERROR: 'OPERATION_ERROR',
} as const;

export type CacheErrorCode = (typeof CacheErrorCode)[keyof typeof CacheErrorCode];

// Domain error codes
export const DomainErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
} as const;

export type DomainErrorCode = (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

// Service error codes
export const ServiceErrorCode = {
  OPERATION_ERROR: 'OPERATION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTEGRATION_ERROR: 'INTEGRATION_ERROR',
  TRANSFORMATION_ERROR: 'TRANSFORMATION_ERROR',
} as const;

export type ServiceErrorCode = (typeof ServiceErrorCode)[keyof typeof ServiceErrorCode];

// Service error interface
export interface ServiceError extends BaseError {
  readonly code: ServiceErrorCode;
}

// ============ Error Types ============

// Base error interface
export interface BaseError {
  readonly name: string;
  readonly message: string;
  readonly code: string;
  readonly details?: unknown;
  readonly cause?: Error;
}

// API error interface
export interface APIError extends BaseError {
  readonly code: APIErrorCode;
}

// Cache error interface
export interface CacheError extends BaseError {
  readonly code: CacheErrorCode;
}

// Domain error interface
export interface DomainError extends BaseError {
  readonly code: DomainErrorCode;
}

// Database error interface
export interface DBError extends BaseError {
  readonly code: DBErrorCode;
}

// Service error interface
export interface ServiceError extends BaseError {
  readonly code: ServiceErrorCode;
}

// Queue error interface
export interface QueueError extends BaseError {
  readonly queueName: string;
  readonly operation: QueueOperation;
}

// ============ Response Types ============

// Standard error response structure
export interface ErrorResponse {
  readonly status: 'error';
  readonly error: string;
  readonly details?: unknown;
}

// Standard API error response format
export interface APIErrorResponse {
  readonly error: string;
}

// ============ Error Creators ============

// Creates an API error
export const createAPIError = (params: {
  code: APIErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): APIError => ({
  name: 'APIError',
  code: params.code,
  message: params.message,
  details: params.details,
  cause: params.cause,
});

// Creates a validation error
export const createValidationError = (params: {
  message: string;
  details?: unknown;
  cause?: Error;
}): APIError =>
  createAPIError({
    code: APIErrorCode.VALIDATION_ERROR,
    ...params,
  });

// Creates a cache error
export const createCacheError = (params: {
  code: CacheErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): CacheError => ({
  name: 'CacheError',
  code: params.code,
  message: params.message,
  details: params.details,
  cause: params.cause,
});

// Creates a domain error
export const createDomainError = (params: {
  code: DomainErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): DomainError => ({
  name: 'DomainError',
  code: params.code,
  message: params.message,
  details: params.details,
  cause: params.cause,
});

// Creates a database error
export const createDBError = (params: {
  code: DBErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): DBError => ({
  name: 'DBError',
  ...params,
});

// Creates a service error
export const createServiceError = (params: {
  code: ServiceErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): ServiceError => ({
  name: 'ServiceError',
  ...params,
});

// Creates a queue error
export const createQueueError = (params: {
  code: QueueErrorCode;
  message: string;
  queueName: string;
  operation: QueueOperation;
  cause?: Error;
}): QueueError => ({
  name: 'QueueError',
  message: params.message,
  code: params.code,
  queueName: params.queueName,
  operation: params.operation,
  cause: params.cause,
});

// ============ Error Type Guards ============

// Type guard for APIError
export const isAPIError = (error: unknown): error is APIError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'message' in error &&
  Object.values(APIErrorCode).includes((error as APIError).code);

// Type guard for CacheError
export const isCacheError = (error: unknown): error is CacheError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'message' in error &&
  Object.values(CacheErrorCode).includes((error as CacheError).code);

// Type guard for DomainError
export const isDomainError = (error: unknown): error is DomainError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'message' in error &&
  Object.values(DomainErrorCode).includes((error as DomainError).code);

// Type guard for DBError
export const isDBError = (error: unknown): error is DBError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'message' in error &&
  Object.values(DBErrorCode).includes((error as DBError).code);

// Type guard for ServiceError
export const isServiceError = (error: unknown): error is ServiceError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'message' in error &&
  (isAPIError(error) || isCacheError(error) || isDomainError(error) || isDBError(error));

// Type guard for QueueError
export const isQueueError = (error: unknown): error is QueueError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'message' in error &&
  'queueName' in error &&
  'operation' in error &&
  Object.values(QueueErrorCode).includes((error as { code: QueueErrorCode }).code) &&
  Object.values(QueueOperation).includes((error as { operation: QueueOperation }).operation);

/**
 * Gets HTTP status code from API error
 */
export const getErrorStatus = (error: APIError): number =>
  error.code === APIErrorCode.NOT_FOUND ? 404 : 500;

/**
 * Formats error response
 */
export const formatErrorResponse = (error: APIError) => ({
  error: error.message,
});
