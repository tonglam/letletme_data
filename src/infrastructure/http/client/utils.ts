/**
 * HTTP Client Utilities
 * @module infrastructure/http/client/utils
 */

import {
  DEFAULT_CONFIG,
  ERROR_CONFIG,
  ErrorCode,
  HTTP_STATUS,
} from '../../../config/http/http.config';
import { APIError, Headers, ResponseMetrics, RetryConfig } from '../../../types/http.type';

/**
 * Creates a monitoring context for request metrics
 */
export const createMonitor = () => {
  const startTime = Date.now();
  return {
    end: (
      path: string,
      method: string,
      result: { status: number; error?: APIError },
    ): ResponseMetrics => ({
      path,
      method,
      startTime,
      duration: Date.now() - startTime,
      status: result.status,
      success: !result.error,
      ...(result.error && { errorCode: result.error.code }),
    }),
  };
};

/**
 * Creates an API error based on status code and message
 */
export const createErrorFromStatus = (
  status: number,
  message: string,
  details?: Record<string, unknown>,
): APIError => {
  const errorConfig = Object.entries(ERROR_CONFIG).find(
    ([, config]) => config.httpStatus === status,
  );
  const errorCode = errorConfig ? (errorConfig[0] as ErrorCode) : ErrorCode.INTERNAL_SERVER_ERROR;

  // Create error object with all properties defined at construction
  const error = {
    ...new Error(message),
    name: 'APIError',
    code: errorCode,
    httpStatus: status,
    details: details || {},
  } as APIError;

  return error;
};

/**
 * Maps HTTP status codes to ErrorCode
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
  attempts: DEFAULT_CONFIG.retry.attempts,
  baseDelay: DEFAULT_CONFIG.retry.baseDelay,
  maxDelay: DEFAULT_CONFIG.retry.maxDelay,
  shouldRetry: (error: Error) => {
    const status =
      'httpStatus' in error ? (error as { httpStatus?: number }).httpStatus : undefined;
    return status === undefined || status >= HTTP_STATUS.SERVER_ERROR_MIN;
  },
};

/**
 * Creates default headers for HTTP requests
 */
export const createDefaultHeaders = (userAgent: string): Headers => ({
  'User-Agent': userAgent,
  Accept: DEFAULT_CONFIG.headers.Accept,
  'Content-Type': DEFAULT_CONFIG.headers['Content-Type'],
});

/**
 * Calculates retry delay with exponential backoff and jitter
 */
export const calculateRetryDelay = (attempt: number, config: RetryConfig): number => {
  const exponentialDelay = config.baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 100; // Small random jitter to prevent thundering herd
  return Math.min(exponentialDelay + jitter, config.maxDelay);
};

/**
 * Creates a delay promise
 */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
