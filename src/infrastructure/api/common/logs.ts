/**
 * HTTP Request Logging Module
 *
 * Provides logging functionality specifically for HTTP requests.
 * Features include:
 * - Request/response logging
 * - Performance tracking
 * - Error logging
 * - Request ID tracking
 *
 * @module infrastructure/api/common/logs
 */

import * as E from 'fp-ts/Either';
import * as path from 'path';
import { Logger, pino } from 'pino';
import { formatLocalTime } from '../../../utils/date';
import { APIError } from './errors';
import { APIResponse } from './Types';

/**
 * HTTP request context for logging
 */
export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly params?: Record<string, unknown>;
  readonly duration?: number;
  readonly requestId?: string;
}

/**
 * Creates a context object for HTTP request logging
 */
export function createRequestContext(
  method: string,
  path: string,
  params?: Record<string, unknown>,
): RequestContext {
  return {
    method,
    path,
    params,
    requestId: generateRequestId(),
  };
}

/**
 * Higher-order function for logging HTTP requests with timing
 */
export function logHttpRequest<T>() {
  return (context: RequestContext) =>
    (response: APIResponse<T>): APIResponse<T> => {
      const duration = context.duration ?? 0;
      const baseLog = {
        requestId: context.requestId,
        method: context.method,
        path: context.path,
        params: sanitizeParams(context.params),
        duration: `${duration}ms`,
      };

      if (response._tag === 'Left') {
        const error = response.left as APIError;
        getSharedLogger(DEFAULT_LOGGER_CONFIG).error(
          {
            ...baseLog,
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          },
          'HTTP request failed',
        );
      } else {
        getSharedLogger(DEFAULT_LOGGER_CONFIG).info(
          {
            ...baseLog,
            success: true,
          },
          'HTTP request successful',
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
 * Sanitizes sensitive data from request parameters
 */
function sanitizeParams(params?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!params) return undefined;

  const sensitiveKeys = ['password', 'token', 'key', 'secret', 'authorization'];
  const sanitized = { ...params };

  Object.keys(sanitized).forEach((key) => {
    if (sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeParams(sanitized[key] as Record<string, unknown>);
    }
  });

  return sanitized;
}

interface LoggerConfig {
  name: string;
  level: string;
  filepath: string;
}

const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  name: 'fpl-api',
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  filepath: 'logs',
};

// Create a singleton logger instance
let sharedLogger: Logger | undefined;

const getSharedLogger = (config: LoggerConfig): Logger => {
  if (!sharedLogger) {
    const logFile = path.join(config.filepath, `${config.name}.log`);

    const transport = pino.transport({
      target: 'pino-pretty',
      options: {
        destination: logFile,
        mkdir: true,
        sync: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss.l',
        colorize: false,
        singleLine: true,
        ignore: 'pid,hostname',
      },
    });

    sharedLogger = pino(
      {
        name: config.name,
        level: config.level,
        base: {},
        timestamp: () => `,"time":"${formatLocalTime(new Date())}"`,
        formatters: {
          level: (label) => ({ level: label.toUpperCase() }),
        },
      },
      transport,
    );
  }
  return sharedLogger;
};

export const createApiLogger = (config: LoggerConfig): Logger => {
  return getSharedLogger(config);
};

export interface ApiCallContext {
  method: string;
  params?: Record<string, unknown>;
}

export const createApiCallContext = (
  method: string,
  params?: Record<string, unknown>,
): ApiCallContext => ({
  method,
  params,
});

export const logApiCall =
  () =>
  <T>(context: ApiCallContext) =>
  (result: E.Either<APIError, T>): E.Either<APIError, T> => {
    const { method, params } = context;
    const sharedLogger = getSharedLogger(DEFAULT_LOGGER_CONFIG);

    if (E.isLeft(result)) {
      sharedLogger.error({
        type: 'api_call_error',
        method,
        params,
        error: result.left,
        correlationId: result.left.correlationId,
      });
    } else {
      sharedLogger.info({
        type: 'api_call',
        method,
        params,
        message: 'Data retrieved successfully',
        correlationId: (result.right as { correlationId?: string })?.correlationId,
      });
    }

    return result;
  };
