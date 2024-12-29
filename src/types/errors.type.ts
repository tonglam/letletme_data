/**
 * Error Types Module
 *
 * Core type definitions for error handling across the application.
 * Follows functional programming principles and provides type safety.
 */

// ============ Error Codes ============

/**
 * API error codes
 */
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

/**
 * Cache error codes
 */
export const CacheErrorCode = {
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  SERIALIZATION_ERROR: 'SERIALIZATION_ERROR',
  DESERIALIZATION_ERROR: 'DESERIALIZATION_ERROR',
} as const;

export type CacheErrorCode = (typeof CacheErrorCode)[keyof typeof CacheErrorCode];

/**
 * Domain error codes
 */
export const DomainErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
} as const;

export type DomainErrorCode = (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

/**
 * Service error codes combining all error types
 */
export type ServiceErrorCode = APIErrorCode | CacheErrorCode | DomainErrorCode;

// ============ Error Types ============

/**
 * Base error interface
 */
export interface BaseError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  readonly cause?: Error;
}

/**
 * API error interface
 */
export interface APIError extends BaseError {
  readonly code: APIErrorCode;
}

/**
 * Cache error interface
 */
export interface CacheError extends BaseError {
  readonly code: CacheErrorCode;
}

/**
 * Domain error interface
 */
export interface DomainError extends BaseError {
  readonly code: DomainErrorCode;
}

/**
 * Service error interface
 */
export interface ServiceError extends BaseError {
  readonly code: ServiceErrorCode;
}

// ============ Response Types ============

/**
 * Standard error response structure
 */
export interface ErrorResponse {
  readonly status: 'error';
  readonly error: string;
  readonly details?: unknown;
}

/**
 * Standard API error response format
 */
export interface APIErrorResponse {
  readonly error: string;
}

// ============ Error Creators ============

/**
 * Creates an API error
 */
export const createAPIError = (params: {
  code: APIErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): APIError => ({
  code: params.code,
  message: params.message,
  details: params.details,
  cause: params.cause,
});

/**
 * Creates a validation error
 */
export const createValidationError = (params: {
  message: string;
  details?: unknown;
  cause?: Error;
}): APIError =>
  createAPIError({
    code: APIErrorCode.VALIDATION_ERROR,
    ...params,
  });

/**
 * Creates a cache error
 */
export const createCacheError = (params: {
  code: CacheErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): CacheError => ({
  code: params.code,
  message: params.message,
  details: params.details,
  cause: params.cause,
});

/**
 * Creates a domain error
 */
export const createDomainError = (params: {
  code: DomainErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): DomainError => ({
  code: params.code,
  message: params.message,
  details: params.details,
  cause: params.cause,
});

/**
 * Creates a service error
 */
export const createServiceError = (params: {
  code: ServiceErrorCode;
  message: string;
  details?: unknown;
  cause?: Error;
}): ServiceError => ({
  code: params.code,
  message: params.message,
  details: params.details,
  cause: params.cause,
});

// ============ Error Utilities ============

/**
 * Converts any error to a service error
 */
export const toServiceError = (error: unknown): ServiceError => {
  if (isServiceError(error)) return error;
  if (isAPIError(error)) return { ...error, code: error.code };
  if (isCacheError(error)) return { ...error, code: error.code };
  if (isDomainError(error)) return { ...error, code: error.code };

  return createServiceError({
    code: APIErrorCode.INTERNAL_SERVER_ERROR,
    message: error instanceof Error ? error.message : 'Unknown error occurred',
    cause: error instanceof Error ? error : undefined,
  });
};

// ============ Type Guards ============

/**
 * Type guard for APIError
 */
export const isAPIError = (error: unknown): error is APIError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'message' in error &&
  Object.values(APIErrorCode).includes((error as APIError).code);

/**
 * Type guard for CacheError
 */
export const isCacheError = (error: unknown): error is CacheError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'message' in error &&
  Object.values(CacheErrorCode).includes((error as CacheError).code);

/**
 * Type guard for DomainError
 */
export const isDomainError = (error: unknown): error is DomainError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  'message' in error &&
  Object.values(DomainErrorCode).includes((error as DomainError).code);

/**
 * Type guard for ServiceError
 */
export const isServiceError = (error: unknown): error is ServiceError =>
  isAPIError(error) || isCacheError(error) || isDomainError(error);

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
