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

export class ValidationError extends Error implements APIError {
  constructor(
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Error handling utilities
export function isAPIError(error: unknown): error is APIError {
  return error instanceof Error && 'status' in error;
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
