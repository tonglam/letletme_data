import { randomUUID } from 'node:crypto';

import { APIError } from '../types';

export class FPLClientError extends Error implements APIError {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    public cause?: Error,
  ) {
    super(message);
    this.name = 'FPLClientError';
  }
}

export class DatabaseError extends Error implements APIError {
  constructor(
    message: string,
    public code?: string,
    public cause?: Error,
    public constraint?: string,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class CacheError extends Error implements APIError {
  constructor(
    message: string,
    public code?: string,
    public cause?: Error,
  ) {
    super(message);
    this.name = 'CacheError';
  }
}

/**
 * A bounded synchronization attempt persisted some work but did not converge.
 * Only scalar counters belong here; messages must not contain entry IDs,
 * upstream payloads, names, or raw URLs.
 */
export class IncompleteDataSyncError extends Error implements APIError {
  public readonly code = 'DATA_SYNC_INCOMPLETE';

  constructor(
    message: string,
    public readonly requiredUnits: number,
    public readonly reusedUnits: number,
    public readonly succeededUnits: number,
    public readonly failedUnits: number,
  ) {
    super(message);
    this.name = 'IncompleteDataSyncError';
  }
}

export class ValidationError extends Error implements APIError {
  public readonly status = 400;
  constructor(
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error implements APIError {
  public readonly status = 404;
  constructor(
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error implements APIError {
  public readonly status = 409;
  constructor(
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ForbiddenError extends Error implements APIError {
  public readonly status = 403;
  constructor(
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

// Error handling utilities
export function isAPIError(error: unknown): error is APIError {
  return error instanceof Error && 'status' in error;
}

export function getHttpStatusFromError(error: unknown): number {
  if (error instanceof ValidationError) return error.status;
  if (error instanceof NotFoundError) return error.status;
  if (error instanceof ConflictError) return error.status;
  if (error instanceof ForbiddenError) return error.status;
  if (isAPIError(error) && typeof error.status === 'number') return error.status;
  return 500;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function getErrorStatus(error: unknown): number {
  if (isAPIError(error) && error.status) {
    return error.status;
  }
  return 500;
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Message safe to send to API clients. 4xx messages are client-actionable and always
 * exposed; 5xx internals (stack fragments, DB/Redis details) stay in the logs and
 * collapse to a generic message in production.
 */
export function getPublicErrorMessage(error: unknown, status: number): string {
  if (status >= 500 && isProductionEnv()) {
    return 'Internal server error';
  }
  return getErrorMessage(error);
}

/** Return only stable, client-actionable business codes. Database, Redis and
 * provider internals never become public error codes in production. */
export function getPublicErrorCode(error: unknown, status: number): string | undefined {
  if (status >= 500 || !isAPIError(error) || typeof error.code !== 'string') return undefined;
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : undefined;
}

/** Accept a caller-provided request id only when it is a bounded safe token. */
export function getOrCreateRequestId(request: Request): string {
  const supplied = request.headers.get('x-request-id')?.trim();
  return supplied && /^[A-Za-z0-9._-]{1,128}$/.test(supplied) ? supplied : randomUUID();
}
