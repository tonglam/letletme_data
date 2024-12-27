import { HTTP_CONFIG } from '../../config/http.config';
import { ErrorCode } from '../../config/http.error.config';
import {
  APIError,
  createBadRequestError,
  createForbiddenError,
  createInternalServerError,
  createNotFoundError,
  createUnauthorizedError,
  createValidationError,
  ERROR_CONFIG,
} from '../errors';
import { Headers, RetryConfig } from '../types';

/**
 * Maps HTTP status codes to ErrorCode
 * Note: Each status code maps to its most specific error type
 */
export const HTTP_STATUS_TO_ERROR = Object.entries(ERROR_CONFIG).reduce(
  (acc, [code, config]) => ({
    ...acc,
    [config.httpStatus]: code as ErrorCode,
  }),
  {} as Record<number, ErrorCode>,
);

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: Readonly<RetryConfig> = {
  attempts: HTTP_CONFIG.RETRY.DEFAULT_ATTEMPTS,
  baseDelay: HTTP_CONFIG.RETRY.BASE_DELAY,
  maxDelay: HTTP_CONFIG.RETRY.MAX_DELAY,
  shouldRetry: (error: Error) => {
    const status =
      'httpStatus' in error ? (error as { httpStatus?: number }).httpStatus : undefined;
    return status === undefined || status >= HTTP_CONFIG.STATUS.SERVER_ERROR_MIN;
  },
};

/**
 * Creates default headers for HTTP requests
 */
export const createDefaultHeaders = (userAgent: string): Headers => ({
  'User-Agent': userAgent,
  Accept: HTTP_CONFIG.HEADERS.ACCEPT,
  'Cache-Control': HTTP_CONFIG.HEADERS.CACHE_CONTROL,
  Pragma: HTTP_CONFIG.HEADERS.PRAGMA,
  Expires: HTTP_CONFIG.HEADERS.EXPIRES,
});

/**
 * Creates an appropriate error based on status code and message
 */
export const createErrorFromStatus = (
  status: number,
  message: string,
  details?: Record<string, unknown>,
): APIError => {
  const errorCode = HTTP_STATUS_TO_ERROR[status] || ErrorCode.INTERNAL_SERVER_ERROR;

  switch (errorCode) {
    case ErrorCode.BAD_REQUEST:
      return createBadRequestError({ message, details });
    case ErrorCode.UNAUTHORIZED:
      return createUnauthorizedError({ message, details });
    case ErrorCode.FORBIDDEN:
      return createForbiddenError({ message, details });
    case ErrorCode.NOT_FOUND:
      return createNotFoundError({ message, details });
    case ErrorCode.VALIDATION_ERROR:
      return createValidationError({ message, details });
    case ErrorCode.INTERNAL_SERVER_ERROR:
    default:
      return createInternalServerError({ message, details });
  }
};

/**
 * Calculates retry delay with exponential backoff and jitter
 */
export const calculateRetryDelay = (attempt: number, config: RetryConfig): number => {
  const exponentialDelay = config.baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * HTTP_CONFIG.RETRY.JITTER_MAX;
  return Math.min(exponentialDelay + jitter, config.maxDelay);
};

/**
 * Creates a delay promise
 */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
