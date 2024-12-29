/**
 * API types and interfaces for the application
 * @module api/types
 */

import { Request } from 'express';

/**
 * Generic API success response wrapper
 * @template T - The type of data being returned
 */
export interface APIResponse<T> {
  readonly status: 'success';
  readonly data: T;
}

/**
 * Standard error response structure
 */
export interface ErrorResponse {
  readonly status: 'error';
  readonly error: string;
  readonly details?: unknown;
}

/**
 * Extended Express Request type with request ID
 */
export type ApiRequest = Request & { id: string };

/**
 * Metadata included in API responses
 */
export interface ResponseMetadata {
  readonly timestamp: number;
  readonly path: string;
  readonly duration?: number;
}

/**
 * Standard pagination parameters for list endpoints
 */
export interface PaginationParams {
  readonly page?: number;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Standard sorting parameters for list endpoints
 */
export interface SortParams {
  readonly sortBy?: string;
  readonly sortOrder?: 'asc' | 'desc';
}
