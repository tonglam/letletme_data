import { Request } from 'express';

// ============ Types ============
/**
 * API Response types
 */
export interface APIResponse<T> {
  readonly status: 'success';
  readonly data: T;
}

export interface ErrorResponse {
  readonly status: 'error';
  readonly error: string;
  readonly details?: unknown;
}

/**
 * API Request types
 */
export type ApiRequest = Request & { id: string };

/**
 * API Response metadata
 */
export interface ResponseMetadata {
  readonly timestamp: number;
  readonly path: string;
  readonly duration?: number;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  readonly page?: number;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Sort parameters
 */
export interface SortParams {
  readonly sortBy?: string;
  readonly sortOrder?: 'asc' | 'desc';
}
