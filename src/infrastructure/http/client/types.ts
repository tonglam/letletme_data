// HTTP Types Module
// Comprehensive type definitions for the HTTP client infrastructure.
// Includes request/response types, client interfaces, and configuration types.
// Ensures type safety and consistent interfaces across the HTTP client implementation.

import { AxiosInstance } from 'axios';
import type { TaskEither } from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { APIError } from '../../../types/error.type';

// HTTP headers type
export type Headers = Record<string, string>;

// Standard API response structure
export interface APIResponse<T = unknown> {
  readonly data: T;
  readonly status: number;
  readonly headers: Record<string, string>;
}

// Error details for HTTP responses with status code information
export interface ErrorDetails extends Record<string, unknown> {
  httpStatus?: number;
}

// Supported HTTP methods for client operations
export enum HttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  PATCH = 'PATCH',
  DELETE = 'DELETE',
  HEAD = 'HEAD',
  OPTIONS = 'OPTIONS',
  TRACE = 'TRACE',
  CONNECT = 'CONNECT',
}

// Generic request body type that can be undefined
export type RequestBody<T> = T | undefined;

/**
 * Request options extending Axios configuration
 */
export type RequestOptions = Record<string, unknown>;

/**
 * Configuration for request retry behavior
 */
export interface RetryConfig {
  readonly attempts: number;
  readonly baseDelay: number;
  readonly maxDelay: number;
  readonly shouldRetry: (error: APIError) => boolean;
}

/**
 * Context required for HTTP client operations
 */
export interface HTTPClientContext {
  readonly client: AxiosInstance;
  readonly retryConfig: RetryConfig;
  readonly logger: Logger;
}

/**
 * Core HTTP client interface with type-safe methods
 */
export interface HTTPClient {
  readonly get: <T>(path: string, options?: RequestOptions) => TaskEither<APIError, T>;
  readonly post: <T, D = unknown>(
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => TaskEither<APIError, T>;
  readonly put: <T, D = unknown>(
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => TaskEither<APIError, T>;
  readonly patch: <T, D = unknown>(
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => TaskEither<APIError, T>;
  readonly delete: <T>(path: string, options?: RequestOptions) => TaskEither<APIError, T>;
  readonly head: (
    path: string,
    options?: RequestOptions,
  ) => TaskEither<APIError, Record<string, string>>;
  readonly options: (
    path: string,
    options?: RequestOptions,
  ) => TaskEither<APIError, Record<string, string>>;
  readonly trace: <T>(path: string, options?: RequestOptions) => TaskEither<APIError, T>;
  readonly connect: <T>(path: string, options?: RequestOptions) => TaskEither<APIError, T>;
  readonly request: <T, D = unknown>(
    method: HttpMethod,
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => TaskEither<APIError, T>;
}

/**
 * Metrics collected for request monitoring
 */
export interface RequestMetrics {
  readonly path: string;
  readonly method: HttpMethod;
  readonly duration: number;
  readonly status: number;
  readonly error?: APIError;
}

/**
 * Interface for request monitoring and metrics collection
 */
export interface RequestMonitor {
  readonly start: number;
  readonly end: (
    path: string,
    method: HttpMethod,
    result: { status: number; error?: APIError },
  ) => RequestMetrics;
}

// Re-export types needed by consumers
export type { APIError } from '../../../types/error.type';
