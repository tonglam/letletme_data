import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getApiLogger, getFplApiLogger, getQueueLogger } from '../infrastructure/logger';

// Types
export interface LogContext {
  [key: string]: unknown;
}

export interface FplApiContext extends LogContext {
  service: string;
  endpoint: string;
}

export interface QueueContext extends LogContext {
  queueName: string;
  jobId: string;
}

// Common utilities
export const generateRequestId = (): string => uuidv4();

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

// Request details helper
export const getRequestDetails = (req: Request): Record<string, unknown> => ({
  ...(req.method !== 'GET' && { body: req.body }),
  userAgent: req.get('user-agent'),
  ip: req.ip,
  headers: sanitizeHeaders(req.headers as Record<string, unknown>),
});

// API Logging
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

// Fpl API Logging
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

export const logFplApiError = (error: Error, context: FplApiContext): void => {
  getFplApiLogger().error({
    err: error,
    requestId: uuidv4(),
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    ...context,
  });
};

// Queue Logging
export const logQueueJob = (message: string, context: QueueContext): void => {
  getQueueLogger().info(
    {
      timestamp: new Date().toISOString(),
      ...context,
    },
    message,
  );
};

export const logQueueError = (error: Error, context: QueueContext): void => {
  getQueueLogger().error({
    err: error,
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    ...context,
  });
};
