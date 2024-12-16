/**
 * Common API and HTTP Types
 * @module infrastructure/api/common/Types
 */

import { AxiosInstance, AxiosRequestConfig, CreateAxiosDefaults } from 'axios';
import { Either } from 'fp-ts/Either';
import { TaskEither } from 'fp-ts/TaskEither';
import { APIError } from './errors';

// ADTs for HTTP Methods
export const HttpMethod = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
  PATCH: 'PATCH',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
  TRACE: 'TRACE',
  CONNECT: 'CONNECT',
} as const;

export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];

// Type-safe URL
export type URL = `http://${string}` | `https://${string}`;

// Type-safe headers
export type Headers = Record<string, string>;

// Type-safe query parameters
export type QueryParams = Readonly<Record<string, string | number | boolean | null | undefined>> & {
  readonly search?: string;
  readonly filter?: Record<string, unknown>;
};

// Type-safe request body
export type RequestBody<T> = Readonly<T>;

/**
 * Request options type excluding method, url, and data
 */
export type RequestOptions = Omit<AxiosRequestConfig, 'method' | 'url' | 'data'> & {
  readonly params?: QueryParams;
  readonly headers?: Headers;
};

/**
 * Configuration for the retry mechanism
 */
export interface RetryConfig {
  readonly attempts: number;
  readonly baseDelay: number;
  readonly maxDelay: number;
  readonly shouldRetry: (error: Error) => boolean;
}

/**
 * Configuration interface for the HTTP client
 */
export interface HTTPClientConfig extends Omit<CreateAxiosDefaults, 'baseURL'> {
  readonly baseURL: URL;
  readonly timeout?: number;
  readonly headers?: Headers;
  readonly retry?: RetryConfig;
  readonly validateStatus?: (status: number) => boolean;
  readonly userAgent?: string;
}

/**
 * HTTP Client context containing dependencies
 */
export interface HTTPClientContext {
  readonly config: HTTPClientConfig;
  readonly client: AxiosInstance;
  readonly retryConfig: RetryConfig;
}

/**
 * API Response wrapper type
 */
export type APIResponse<T> = Either<APIError, T>;

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
 * API Response metadata
 */
export interface ResponseMetadata {
  readonly timestamp: number;
  readonly path: string;
  readonly duration?: number;
}

/**
 * HTTP Client Interface
 * Provides type-safe HTTP methods with functional error handling
 */
export interface HTTPClient {
  get: <T>(path: string, options?: RequestOptions) => TaskEither<APIError, T>;
  post: <T, D = unknown>(
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => TaskEither<APIError, T>;
  put: <T, D = unknown>(
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => TaskEither<APIError, T>;
  patch: <T, D = unknown>(
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => TaskEither<APIError, T>;
  delete: <T>(path: string, options?: RequestOptions) => TaskEither<APIError, T>;
  head: (path: string, options?: RequestOptions) => TaskEither<APIError, Headers>;
  options: (path: string, options?: RequestOptions) => TaskEither<APIError, Headers>;
  trace: <T>(path: string, options?: RequestOptions) => TaskEither<APIError, T>;
  connect: <T>(path: string, options?: RequestOptions) => TaskEither<APIError, T>;
  request: <T, D = unknown>(
    method: HttpMethod,
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => TaskEither<APIError, T>;
}
