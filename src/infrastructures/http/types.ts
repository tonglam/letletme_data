import { AxiosInstance } from 'axios';
import type { TaskEither } from 'fp-ts/TaskEither';
import { Logger } from 'pino';

import { APIError } from '../../types/error.type';

export type Headers = Record<string, string>;

export interface APIResponse<T = unknown> {
  readonly data: T;
  readonly status: number;
  readonly headers: Record<string, string>;
}

export interface ErrorDetails extends Record<string, unknown> {
  httpStatus?: number;
}

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

export type RequestBody<T> = T | undefined;

export type RequestOptions = Record<string, unknown>;

export interface RetryConfig {
  readonly attempts: number;
  readonly baseDelay: number;
  readonly maxDelay: number;
  readonly shouldRetry: (error: APIError) => boolean;
}

export interface HTTPClientContext {
  readonly client: AxiosInstance;
  readonly retryConfig: RetryConfig;
  readonly logger: Logger;
}

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

export interface RequestMetrics {
  readonly path: string;
  readonly method: HttpMethod;
  readonly duration: number;
  readonly status: number;
  readonly error?: APIError;
}

export interface RequestMonitor {
  readonly start: number;
  readonly end: (
    path: string,
    method: HttpMethod,
    result: { status: number; error?: APIError },
  ) => RequestMetrics;
}

export type { APIError } from '../../types/error.type';
