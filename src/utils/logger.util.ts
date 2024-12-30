/**
 * Logger Utility Module
 *
 * Utility functions for logging operations.
 */

import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getApiLogger, getFplApiLogger, getQueueLogger } from '../infrastructures/logger';

/**
 * Base logging context interface
 */
export interface LogContext {
  [key: string]: unknown;
}

/**
 * FPL API logging context interface
 */
export interface FplApiContext extends LogContext {
  service: string;
  endpoint: string;
}

/**
 * Queue logging context interface
 */
export interface QueueContext extends LogContext {
  queueName: string;
  jobId: string;
}

/**
 * Generates a unique request ID
 */
export const generateRequestId = (): string => uuidv4();

/**
 * Sanitizes request headers by redacting sensitive information
 */
export const sanitizeHeaders = (headers: Record<string, unknown>): Record<string, unknown> => {
  const sanitized = { ...headers };
  const sensitiveKeys = ['authorization', 'cookie', 'token'];

  Object.keys(sanitized).forEach((key) => {
    if (sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
      sanitized[key] = '[REDACTED]';
    }
  });

  return sanitized;
};

/**
 * Extracts relevant details from a request
 */
export const getRequestDetails = (req: Request): Record<string, unknown> => ({
  ...(req.method !== 'GET' && { body: req.body }),
  userAgent: req.get('user-agent'),
  ip: req.ip,
  headers: sanitizeHeaders(req.headers as Record<string, unknown>),
});

/**
 * Logs API request information
 */
export const logApiRequest = (req: Request, message: string, context?: LogContext): void => {
  getApiLogger().info(
    {
      requestId: req.id,
      method: req.method,
      url: req.originalUrl,
      ...getRequestDetails(req),
      ...context,
    },
    message,
  );
};

/**
 * Logs API error information
 */
export const logApiError = (req: Request, error: Error, context?: LogContext): void => {
  getApiLogger().error({
    err: error,
    requestId: req.id,
    url: req.originalUrl,
    method: req.method,
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    ...context,
  });
};

/**
 * Logs FPL API call information
 */
export const logFplApiCall = (message: string, context: FplApiContext): void => {
  getFplApiLogger().info(
    {
      requestId: uuidv4(),
      timestamp: new Date().toISOString(),
      ...context,
    },
    message,
  );
};

/**
 * Logs FPL API error information
 */
export const logFplApiError = (error: Error, context: FplApiContext): void => {
  getFplApiLogger().error({
    err: error,
    requestId: uuidv4(),
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    ...context,
  });
};

/**
 * Logs queue job information
 */
export const logQueueJob = (message: string, context: QueueContext): void => {
  getQueueLogger().info(
    {
      timestamp: new Date().toISOString(),
      ...context,
    },
    message,
  );
};

/**
 * Logs queue error information
 */
export const logQueueError = (error: Error, context: QueueContext): void => {
  getQueueLogger().error({
    err: error,
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    ...context,
  });
};
