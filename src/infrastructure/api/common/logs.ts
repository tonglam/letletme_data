/**
 * API Logging Module
 *
 * Provides structured logging functionality for API operations using Pino.
 * Features include:
 * - Structured log format
 * - Log rotation
 * - Log level management
 * - Parameter sanitization
 * - Performance tracking
 *
 * @module infrastructure/api/common/logs
 */

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import pino from 'pino';

/**
 * Available log levels in order of increasing severity
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Context information added to all logs
 */
export interface LogContext extends Record<string, unknown> {
  readonly service: string; // Service/component name
  readonly environment: string; // Runtime environment
  readonly timestamp: string; // ISO timestamp
}

/**
 * Logger configuration options
 */
export interface LogConfig {
  readonly name: string; // Logger instance name
  readonly level: LogLevel; // Minimum log level
  readonly filepath: string; // Log file path
  readonly rotation?: {
    // Log rotation settings
    readonly size: string; // Max file size before rotation
    readonly count: number; // Number of files to keep
    readonly compress: boolean; // Whether to compress rotated logs
  };
}

/**
 * Context for API call logging
 */
export interface ApiCallContext {
  readonly endpoint: string; // API endpoint called
  readonly params: Record<string, unknown>; // Request parameters
  readonly startTime: number; // Call start timestamp
  readonly context?: LogContext; // Additional context
}

/**
 * Default logging configuration
 */
const DEFAULT_LOG_CONFIG: Required<Pick<LogConfig, 'level' | 'rotation'>> = {
  level: 'info',
  rotation: {
    size: '10M',
    count: 5,
    compress: true,
  },
};

/**
 * Creates a configured logger instance for API operations
 *
 * @param config - Partial logger configuration
 * @returns Configured Pino logger instance
 */
export const createApiLogger = (config: Partial<LogConfig>) => {
  const finalConfig = {
    level: DEFAULT_LOG_CONFIG.level,
    rotation: DEFAULT_LOG_CONFIG.rotation,
    ...config,
    name: config.name ?? 'api',
    filepath: config.filepath ?? `./logs/${config.name ?? 'api'}.log`,
  } satisfies LogConfig;

  return pino({
    name: finalConfig.name,
    level: finalConfig.level,
    transport: {
      target: 'pino/file',
      options: {
        destination: finalConfig.filepath,
        mkdir: true,
        sync: false,
        rotate: finalConfig.rotation,
      },
    },
  });
};

/**
 * Higher-order function for logging API calls
 * Handles both successful and failed calls with appropriate logging levels
 *
 * @param logger - Pino logger instance
 * @returns Function that takes context and logs API call results
 */
export const logApiCall =
  (logger: pino.Logger) =>
  (context: ApiCallContext) =>
  <T>(result: E.Either<Error, T>): E.Either<Error, T> => {
    const { endpoint, params, startTime, context: logContext } = context;
    const duration = Date.now() - startTime;

    const baseLogContext = {
      endpoint,
      params: sanitizeParams(params),
      duration,
      ...(logContext ?? {}),
    };

    pipe(
      result,
      E.fold(
        (error) => {
          logger.error(
            {
              ...baseLogContext,
              error: {
                message: error.message,
                name: error.name,
                ...(error instanceof Error && error.cause ? { cause: error.cause } : {}),
              },
            },
            'API call failed',
          );
        },
        () => {
          // Log successful calls only if they're slow
          if (duration > 1000) {
            logger.warn(baseLogContext, 'Slow API call');
          } else {
            logger.debug(baseLogContext, 'API call completed');
          }
        },
      ),
    );

    return result;
  };

/**
 * Creates context for API call logging
 *
 * @param endpoint - API endpoint being called
 * @param params - Request parameters
 * @param context - Additional context information
 * @returns ApiCallContext object
 */
export const createApiCallContext = (
  endpoint: string,
  params: Record<string, unknown> = {},
  context?: LogContext,
): ApiCallContext => ({
  endpoint,
  params,
  startTime: Date.now(),
  context,
});

/**
 * Type for API call parameters that will be logged
 */
export type ApiCallParams = Record<string, unknown>;

/**
 * Sanitizes parameters for logging
 * - Removes sensitive information
 * - Truncates long values
 * - Handles nested objects
 *
 * @param params - Parameters to sanitize
 * @returns Sanitized parameters safe for logging
 */
export const sanitizeParams = (params: ApiCallParams): ApiCallParams => {
  const sanitized: ApiCallParams = {};

  for (const [key, value] of Object.entries(params)) {
    // Skip sensitive fields
    if (
      key.toLowerCase().includes('password') ||
      key.toLowerCase().includes('token') ||
      key.toLowerCase().includes('secret')
    ) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    // Truncate long strings
    if (typeof value === 'string' && value.length > 1000) {
      sanitized[key] = `${value.substring(0, 1000)}...`;
      continue;
    }

    // Handle nested objects
    if (value && typeof value === 'object') {
      sanitized[key] = sanitizeParams(value as ApiCallParams);
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
};
