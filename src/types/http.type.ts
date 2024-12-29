/**
 * HTTP Types Module
 *
 * Core type definitions for HTTP client operations.
 * Includes client interfaces, request/response types, and configuration.
 * @module types/http
 */

import { AxiosInstance } from 'axios';
import type { TaskEither } from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { APIError } from './errors.type';

/**
 * HTTP Methods supported by the client
 */
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

/**
 * Request body type
 */
export type RequestBody<T> = T | undefined;

/**
 * Request options type extending axios config
 */
export type RequestOptions = Record<string, unknown>;

/**
 * Retry configuration for HTTP requests
 */
export interface RetryConfig {
  readonly attempts: number;
  readonly baseDelay: number;
  readonly maxDelay: number;
  readonly shouldRetry: (error: APIError) => boolean;
}

/**
 * Context for HTTP client operations
 */
export interface HTTPClientContext {
  readonly client: AxiosInstance;
  readonly retryConfig: RetryConfig;
  readonly logger: Logger;
}

/**
 * HTTP client interface
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
 * Request metrics for monitoring
 */
export interface RequestMetrics {
  readonly path: string;
  readonly method: HttpMethod;
  readonly duration: number;
  readonly status: number;
  readonly error?: APIError;
}

/**
 * Monitor interface for request tracking
 */
export interface RequestMonitor {
  readonly start: number;
  readonly end: (
    path: string,
    method: HttpMethod,
    result: { status: number; error?: APIError },
  ) => RequestMetrics;
}
