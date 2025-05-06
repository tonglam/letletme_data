import { NotFoundError, ValidationError } from '@app/application/errors';

export type ErrorDetails = Record<string, unknown>;

export interface BaseError extends Error {
  readonly _tag: string;
  readonly code: string;
  readonly cause?: Error;
  readonly details?: ErrorDetails;
  readonly timestamp: Date;
}

export interface DBError extends BaseError {
  readonly _tag: 'DBError';
  readonly code: DBErrorCode;
}
export interface CacheError extends BaseError {
  readonly _tag: 'CacheError';
  readonly code: CacheErrorCode;
}

export enum NetworkErrorCode {
  TIMEOUT = 'NETWORK_TIMEOUT',
  CONNECTION_REFUSED = 'NETWORK_CONNECTION_REFUSED',
  DNS_LOOKUP_FAILED = 'NETWORK_DNS_LOOKUP_FAILED',
  UNKNOWN = 'NETWORK_UNKNOWN',
}

export interface NetworkError extends BaseError {
  readonly _tag: 'NetworkError';
  readonly code: NetworkErrorCode;
}

export type AppError = DBError | CacheError | NetworkError | ValidationError | NotFoundError;

export enum DBErrorCode {
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  QUERY_ERROR = 'QUERY_ERROR',
  CONSTRAINT_ERROR = 'CONSTRAINT_ERROR',
  OPERATION_ERROR = 'OPERATION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  TRANSFORMATION_ERROR = 'TRANSFORMATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
}

export const createDBError = (params: {
  code: DBErrorCode;
  message: string;
  cause?: Error;
  details?: ErrorDetails;
}): DBError => ({
  _tag: 'DBError',
  name: 'DBError',
  stack: new Error().stack,
  timestamp: new Date(),
  ...params,
});

export enum CacheErrorCode {
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  OPERATION_ERROR = 'CACHE_OPERATION_ERROR',
  SERIALIZATION_ERROR = 'SERIALIZATION_ERROR',
  DESERIALIZATION_ERROR = 'CACHE_DESERIALIZATION_ERROR',
  DATA_PROVIDER_ERROR = 'CACHE_DATA_PROVIDER_ERROR',
  NOT_FOUND = 'CACHE_NOT_FOUND',
}

export const createCacheError = (params: {
  code: CacheErrorCode;
  message: string;
  cause?: Error;
  details?: ErrorDetails;
}): CacheError => ({
  _tag: 'CacheError',
  name: 'CacheError',
  stack: new Error().stack,
  timestamp: new Date(),
  ...params,
});

export const createNetworkError = (params: {
  code: NetworkErrorCode;
  message: string;
  cause?: Error;
  details?: ErrorDetails;
}): NetworkError => ({
  _tag: 'NetworkError',
  name: 'NetworkError',
  stack: new Error().stack,
  timestamp: new Date(),
  ...params,
});

export enum DomainErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  CACHE_ERROR = 'CACHE_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  NOT_FOUND = 'NOT_FOUND',
}

export interface DomainError extends BaseError {
  readonly _tag: 'DomainError';
  readonly code: DomainErrorCode;
}

export const createDomainError = (params: {
  code: DomainErrorCode;
  message: string;
  cause?: Error;
  details?: ErrorDetails;
}): DomainError => ({
  _tag: 'DomainError',
  name: 'DomainError',
  stack: new Error().stack,
  timestamp: new Date(),
  ...params,
});

export enum APIErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  SERVICE_ERROR = 'SERVICE_ERROR',
}

export interface APIError extends BaseError {
  readonly _tag: 'APIError';
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
  _tag: 'APIError',
  name: 'APIError',
  stack: params.cause?.stack || undefined,
  timestamp: new Date(),
  ...params,
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
