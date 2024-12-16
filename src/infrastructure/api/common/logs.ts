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
import { Logger, pino } from 'pino';
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
export function logHttpRequest<T>(logger: Logger) {
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
        logger.error(
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
        logger.info(
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

export const createApiLogger = (config: {
  name: string;
  level: string;
  filepath: string;
}): Logger => {
  return pino({
    name: config.name,
    level: config.level,
    transport: {
      target: 'pino/file',
      options: { destination: config.filepath },
    },
  });
};

export const logApiCall =
  (logger: Logger) =>
  <T>(context: ApiCallContext) =>
  (result: E.Either<APIError, T>): E.Either<APIError, T> => {
    const { method, params } = context;

    if (E.isLeft(result)) {
      logger.error({ error: result.left, params }, `API call failed: ${method}`);
    } else {
      logger.info({ params }, `API call succeeded: ${method}`);
    }

    return result;
  };
