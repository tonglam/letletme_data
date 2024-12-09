import { AxiosRequestConfig } from 'axios';
import { Either } from 'fp-ts/Either';
import { BaseError } from './errors';

/**
 * Common request options type excluding method, url, and data
 */
export type RequestOptions = Omit<AxiosRequestConfig, 'method' | 'url' | 'data'>;

/**
 * API Response wrapper type
 */
export type APIResponse<T> = Either<BaseError, T>;

/**
 * Common HTTP headers type
 */
export type HTTPHeaders = Record<string, string>;

/**
 * API Client configuration
 */
export interface APIClientConfig {
  readonly baseURL: string;
  readonly timeout?: number;
  readonly headers?: HTTPHeaders;
  readonly validateStatus?: (status: number) => boolean;
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

/**
 * Common query parameters
 */
export interface QueryParams extends PaginationParams, SortParams {
  readonly search?: string;
  readonly filter?: Record<string, unknown>;
}

/**
 * API Response metadata
 */
export interface ResponseMetadata {
  readonly timestamp: number;
  readonly path: string;
  readonly duration?: number;
}
