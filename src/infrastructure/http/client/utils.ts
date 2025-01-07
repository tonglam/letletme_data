/**
 * HTTP Client Utilities
 * @module infrastructure/http/client/utils
 */

import { DEFAULT_CONFIG, ERROR_CONFIG, HTTP_STATUS } from '../../../config/http/http.config';
import { APIError, APIErrorCode } from '../../../types/error.type';
import { ErrorDetails, HttpMethod, RequestMetrics, RetryConfig } from './types';

/**
 * Creates a monitoring context for request metrics
 */
export const createMonitor = () => {
  const startTime = Date.now();
  return {
    end: (
      path: string,
      method: HttpMethod,
      result: { status: number; error?: APIError },
    ): RequestMetrics => ({
      path,
      method,
      duration: Date.now() - startTime,
      status: result.status,
      error: result.error,
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
  let errorCode: APIErrorCode;

  if (status >= HTTP_STATUS.CLIENT_ERROR_MIN && status <= HTTP_STATUS.CLIENT_ERROR_MAX) {
    errorCode = APIErrorCode.SERVICE_ERROR;
  } else {
    const errorConfig = Object.entries(ERROR_CONFIG).find(
      ([, config]) => config.httpStatus === status,
    );
    errorCode = errorConfig ? (errorConfig[0] as APIErrorCode) : APIErrorCode.INTERNAL_SERVER_ERROR;
  }

  return {
    name: 'APIError',
    code: errorCode,
    message,
    details: {
      ...(details || {}),
      httpStatus: status,
    } as ErrorDetails,
    timestamp: new Date(),
  };
};

/**
 * Maps HTTP status codes to ErrorCode
 */
export const HTTP_STATUS_TO_ERROR = Object.entries(ERROR_CONFIG).reduce(
  (acc, [code, config]) => ({
    ...acc,
    [config.httpStatus]: code as APIErrorCode,
  }),
  {} as Record<number, APIErrorCode>,
);

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: Readonly<RetryConfig> = {
  attempts: DEFAULT_CONFIG.retry.attempts,
  baseDelay: DEFAULT_CONFIG.retry.baseDelay,
  maxDelay: DEFAULT_CONFIG.retry.maxDelay,
  shouldRetry: (error: APIError) => {
    const details = error.details as ErrorDetails;
    return details.httpStatus === undefined || details.httpStatus >= HTTP_STATUS.SERVER_ERROR_MIN;
  },
};

/**
 * Creates default headers for HTTP requests
 */
export const createDefaultHeaders = (userAgent: string): Record<string, string> => ({
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

/**
 * Creates an API error based on status code and message
 */
export const createHTTPError = (
  code: APIErrorCode,
  message: string,
  details: ErrorDetails,
): APIError => ({
  name: 'APIError',
  code,
  message,
  details,
  timestamp: new Date(),
});
