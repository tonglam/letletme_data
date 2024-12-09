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

import pino, { Logger } from 'pino';
import { BaseError } from './errors';
import { APIResponse } from './types';

/**
 * Logger configuration interface
 */
export interface LoggerConfig {
  readonly name: string;
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly filepath?: string;
  readonly prettyPrint?: boolean;
}

/**
 * API call context for logging
 */
export interface ApiCallContext {
  readonly method: string;
  readonly path: string;
  readonly params?: Record<string, unknown>;
  readonly duration?: number;
  readonly requestId?: string;
}

/**
 * Creates a configured pino logger instance
 */
export function createApiLogger(config: LoggerConfig): Logger {
  const transport = config.filepath
    ? {
        target: 'pino/file',
        options: { destination: config.filepath },
      }
    : config.prettyPrint
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined;

  return pino({
    name: config.name,
    level: config.level,
    transport,
    redact: {
      paths: ['*.password', '*.token', '*.key', '*.secret'],
      remove: true,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    base: {
      env: process.env.NODE_ENV,
    },
  });
}

/**
 * Creates a context object for API call logging
 */
export function createApiCallContext(
  method: string,
  params?: Record<string, unknown>,
): ApiCallContext {
  return {
    method,
    path: `/${method}`,
    params,
    requestId: generateRequestId(),
  };
}

/**
 * Higher-order function for logging API calls with timing
 */
export function logApiCall<T>(logger: Logger) {
  return (context: ApiCallContext) =>
    (response: APIResponse<T>): APIResponse<T> => {
      const duration = context.duration ?? 0;
      const baseLog = {
        requestId: context.requestId,
        method: context.method,
        path: context.path,
        params: context.params,
        duration: `${duration}ms`,
      };

      if (response._tag === 'Left') {
        const error = response.left as BaseError;
        logger.error(
          {
            ...baseLog,
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          },
          'API call failed',
        );
      } else {
        logger.info(
          {
            ...baseLog,
            success: true,
          },
          'API call successful',
        );
      }

      return response;
    };
}

/**
 * Generates a unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Creates a child logger with additional context
 */
export function createContextLogger(logger: Logger, context: Record<string, unknown>): Logger {
  return logger.child(context);
}

/**
 * Sanitizes sensitive data from objects before logging
 */
export function sanitizeLogData<T extends Record<string, unknown>>(
  data: T,
): Record<string, unknown> {
  const sensitiveKeys = ['password', 'token', 'key', 'secret', 'authorization'];
  const sanitized = { ...data } as Record<string, unknown>;

  Object.keys(sanitized).forEach((key) => {
    if (sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeLogData(sanitized[key] as Record<string, unknown>);
    }
  });

  return sanitized;
}
