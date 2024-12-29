/**
 * HTTP Configuration
 * @module config/http
 */

import { RetryConfig } from '../../infrastructure/http/client/types';

// HTTP Status Codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
  CLIENT_ERROR_MIN: 400,
  CLIENT_ERROR_MAX: 499,
  SERVER_ERROR_MIN: 500,
  SERVER_ERROR_MAX: 599,
} as const;

// Error Codes
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// Error Configuration
export const ERROR_CONFIG = {
  [ErrorCode.BAD_REQUEST]: {
    httpStatus: HTTP_STATUS.BAD_REQUEST,
    message: 'Bad Request',
  },
  [ErrorCode.UNAUTHORIZED]: {
    httpStatus: HTTP_STATUS.UNAUTHORIZED,
    message: 'Unauthorized',
  },
  [ErrorCode.FORBIDDEN]: {
    httpStatus: HTTP_STATUS.FORBIDDEN,
    message: 'Forbidden',
  },
  [ErrorCode.NOT_FOUND]: {
    httpStatus: HTTP_STATUS.NOT_FOUND,
    message: 'Not Found',
  },
  [ErrorCode.VALIDATION_ERROR]: {
    httpStatus: HTTP_STATUS.UNPROCESSABLE_ENTITY,
    message: 'Validation Error',
  },
  [ErrorCode.RATE_LIMIT_EXCEEDED]: {
    httpStatus: HTTP_STATUS.TOO_MANY_REQUESTS,
    message: 'Rate Limit Exceeded',
  },
  [ErrorCode.INTERNAL_SERVER_ERROR]: {
    httpStatus: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    message: 'Internal Server Error',
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    httpStatus: HTTP_STATUS.SERVICE_UNAVAILABLE,
    message: 'Service Unavailable',
  },
} as const;

// HTTP Headers
export const HEADERS = {
  ACCEPT: 'application/json',
  CONTENT_TYPE: 'application/json',
  CACHE_CONTROL: 'no-cache',
  PRAGMA: 'no-cache',
  EXPIRES: '0',
} as const;

// Retry Configuration
export const RETRY = {
  DEFAULT_ATTEMPTS: 3,
  BASE_DELAY: 1000,
  MAX_DELAY: 5000,
  JITTER_MAX: 100,
} as const;

// Default Configuration
export const DEFAULT_CONFIG = {
  timeout: 30000,
  headers: {
    'Content-Type': HEADERS.CONTENT_TYPE,
    Accept: HEADERS.ACCEPT,
  },
  retry: {
    attempts: RETRY.DEFAULT_ATTEMPTS,
    baseDelay: RETRY.BASE_DELAY,
    maxDelay: RETRY.MAX_DELAY,
  } as RetryConfig,
} as const;

// Metrics Configuration
export interface MetricsConfig {
  readonly enabled: boolean;
  readonly slowRequestThreshold: number;
}
