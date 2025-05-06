import { getApiLogger, getFplApiLogger } from '@app/infrastructure/logging/logger';
import { Context } from 'elysia';
import { v4 as uuidv4 } from 'uuid';

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

export const getRequestDetails = (ctx: Context): Record<string, unknown> => ({
  ...(ctx.request.method !== 'GET' && { body: ctx.body }),
  userAgent: ctx.request.headers.get('user-agent'),
  ip: ctx.request.headers.get('x-forwarded-for') ?? null,
  headers: sanitizeHeaders(Object.fromEntries(ctx.request.headers.entries())),
});

export const logApiRequest = (ctx: Context, message: string, context?: LogContext): void => {
  getApiLogger().info(
    {
      requestId: generateRequestId(),
      method: ctx.request.method,
      url: ctx.path,
      ...getRequestDetails(ctx),
      ...context,
    },
    message,
  );
};

export const logApiError = (ctx: Context, error: Error, context?: LogContext): void => {
  getApiLogger().error({
    err: error,
    requestId: generateRequestId(),
    url: ctx.path,
    method: ctx.request.method,
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    ...context,
  });
};

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

export const logApp = (message: string, context?: LogContext): void => {
  getApiLogger().info(
    {
      timestamp: new Date().toISOString(),
      ...context,
    },
    message,
  );
};

export const logAppError = (error: Error, context?: LogContext): void => {
  getApiLogger().error({
    err: error,
    timestamp: new Date().toISOString(),
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    ...context,
  });
};

export const logJob = (message: string, context: QueueContext): void => {
  getApiLogger().info(
    {
      timestamp: new Date().toISOString(),
      ...context,
    },
    message,
  );
};

export const logJobError = (error: Error, context: QueueContext): void => {
  getApiLogger().error({
    err: error,
    timestamp: new Date().toISOString(),
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    ...context,
  });
};

export const logWorkflow = (message: string, context?: LogContext): void => {
  getApiLogger().info(
    {
      timestamp: new Date().toISOString(),
      ...context,
    },
    message,
  );
};

export const logWorkflowError = (error: Error, context?: LogContext): void => {
  getApiLogger().error({
    err: error,
    timestamp: new Date().toISOString(),
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    ...context,
  });
};
