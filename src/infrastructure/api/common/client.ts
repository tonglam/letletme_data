/**
 * HTTP Client Module
 *
 * A type-safe, functional HTTP client built on top of Axios with enhanced features:
 * - Type-safe request/response handling using generics
 * - Functional error handling using fp-ts Either
 * - Configurable retry mechanism with exponential backoff
 * - Request/response interceptors
 * - Comprehensive error handling and logging
 *
 * @module infrastructure/api/common/client
 */

import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  CreateAxiosDefaults,
  InternalAxiosRequestConfig,
} from 'axios';
import { Either, left, map, right } from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { HTTP_CONFIG, HTTPErrorCode } from '../config/http.config';

/**
 * Represents an HTTP error with standardized structure
 */
export type HTTPError = {
  readonly code: HTTPErrorCode; // Error code from HTTP_CONFIG
  readonly message: string; // Human-readable error message
  readonly statusCode?: number; // HTTP status code if available
  readonly details?: unknown; // Additional error details
};

/**
 * Request options type excluding method, url, and data
 * These are handled separately in the specific method calls
 */
export type RequestOptions = Omit<AxiosRequestConfig, 'method' | 'url' | 'data'>;

/**
 * Configuration for the retry mechanism
 */
export interface RetryConfig {
  readonly attempts: number; // Maximum number of retry attempts
  readonly baseDelay: number; // Base delay between retries in ms
  readonly maxDelay: number; // Maximum delay between retries in ms
  readonly shouldRetry: (error: Error) => boolean; // Function to determine if retry should occur
}

/**
 * Custom API error class with enhanced error information
 */
export class APIError extends Error {
  constructor(
    message: string,
    public readonly code: HTTPErrorCode,
    public readonly statusCode?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'APIError';
  }

  /**
   * Creates an APIError from an Axios error
   */
  static fromAxiosError(error: AxiosError): APIError {
    return new APIError(
      error.message,
      (error.code as HTTPErrorCode) ?? HTTP_CONFIG.ERROR.UNKNOWN_ERROR,
      error.response?.status,
      error.response?.data,
    );
  }

  /**
   * Creates an APIError from a generic Error
   */
  static fromError(error: Error): APIError {
    return new APIError(
      error.message,
      HTTP_CONFIG.ERROR.INTERNAL_ERROR,
      HTTP_CONFIG.STATUS.SERVER_ERROR_MIN,
      error,
    );
  }
}

/**
 * Configuration interface for the HTTP client
 */
export interface HTTPClientConfig extends CreateAxiosDefaults {
  readonly baseURL: string; // Base URL for all requests
  readonly timeout?: number; // Request timeout in ms
  readonly headers?: Record<string, string>; // Custom headers
  readonly retry?: RetryConfig; // Retry configuration
  readonly validateStatus?: (status: number) => boolean; // Status validation
  readonly userAgent?: string; // Custom user agent
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  attempts: HTTP_CONFIG.RETRY.DEFAULT_ATTEMPTS,
  baseDelay: HTTP_CONFIG.RETRY.BASE_DELAY,
  maxDelay: HTTP_CONFIG.RETRY.MAX_DELAY,
  shouldRetry: (error: Error) =>
    error instanceof APIError &&
    (error.statusCode === undefined || error.statusCode >= HTTP_CONFIG.STATUS.SERVER_ERROR_MIN),
};

/**
 * HTTP Client class providing type-safe HTTP methods with enhanced features
 */
export class HTTPClient {
  private readonly client: AxiosInstance;
  private readonly config: HTTPClientConfig;
  private readonly retry: RetryConfig;

  constructor(config: HTTPClientConfig) {
    this.config = {
      timeout: HTTP_CONFIG.TIMEOUT.DEFAULT,
      validateStatus: (status: number) =>
        status >= HTTP_CONFIG.STATUS.OK_MIN && status < HTTP_CONFIG.STATUS.OK_MAX,
      userAgent: HTTP_CONFIG.HEADERS.DEFAULT_USER_AGENT,
      ...config,
    };
    this.retry = { ...DEFAULT_RETRY_CONFIG, ...config.retry };

    this.client = axios.create({
      ...this.config,
      headers: {
        ...this.createDefaultHeaders(),
        ...config.headers,
      },
    });
    this.setupInterceptors();
  }

  /**
   * Creates default headers for requests
   */
  private createDefaultHeaders(): Record<string, string> {
    return {
      'User-Agent': this.config.userAgent ?? HTTP_CONFIG.HEADERS.DEFAULT_USER_AGENT,
      Accept: HTTP_CONFIG.HEADERS.ACCEPT,
      'Cache-Control': HTTP_CONFIG.HEADERS.CACHE_CONTROL,
      Pragma: HTTP_CONFIG.HEADERS.PRAGMA,
      Expires: HTTP_CONFIG.HEADERS.EXPIRES,
    };
  }

  /**
   * Sets up request and response interceptors
   */
  private setupInterceptors(): void {
    // Request interceptor
    this.client.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        if (!config.url) {
          throw new APIError('URL is required', HTTP_CONFIG.ERROR.INVALID_REQUEST);
        }

        try {
          // Add timestamp to prevent caching
          const url = new URL(
            config.url.startsWith('http') ? config.url : `${config.baseURL || ''}${config.url}`,
          );
          url.searchParams.append(HTTP_CONFIG.CACHE.TIMESTAMP_PARAM, Date.now().toString());
          config.url = url.toString();
        } catch (error) {
          throw new APIError(
            'Invalid URL configuration',
            HTTP_CONFIG.ERROR.INVALID_REQUEST,
            HTTP_CONFIG.STATUS.CLIENT_ERROR_MIN,
            error,
          );
        }

        return config;
      },
      (error: unknown) => {
        const apiError =
          error instanceof Error
            ? APIError.fromError(error)
            : new APIError('Unknown request error', HTTP_CONFIG.ERROR.UNKNOWN_ERROR);
        return Promise.reject(apiError);
      },
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response: AxiosResponse) => response,
      (error: unknown) => {
        const apiError = axios.isAxiosError(error)
          ? APIError.fromAxiosError(error)
          : error instanceof Error
            ? APIError.fromError(error)
            : new APIError('Unknown response error', HTTP_CONFIG.ERROR.UNKNOWN_ERROR);
        return Promise.reject(apiError);
      },
    );
  }

  async get<T>(path: string, options?: RequestOptions): Promise<Either<APIError, T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  async post<T>(
    path: string,
    data?: unknown,
    options?: RequestOptions,
  ): Promise<Either<APIError, T>> {
    return this.request<T>('POST', path, data, options);
  }

  /**
   * HEAD request for retrieving headers only
   */
  async head(
    path: string,
    options?: RequestOptions,
  ): Promise<Either<APIError, Record<string, string>>> {
    const result = await this.request<void>('HEAD', path, undefined, options);
    return pipe(
      result,
      map(() => this.client.defaults.headers as Record<string, string>),
    );
  }

  /**
   * OPTIONS request for checking API capabilities
   */
  async options(
    path: string,
    options?: RequestOptions,
  ): Promise<Either<APIError, Record<string, string>>> {
    const result = await this.request<void>('OPTIONS', path, undefined, options);
    return pipe(
      result,
      map(() => {
        const headers = this.client.defaults.headers as Record<string, string>;
        return {
          allow: headers['allow'] ?? '',
          'access-control-allow-methods': headers['access-control-allow-methods'] ?? '',
          'access-control-allow-headers': headers['access-control-allow-headers'] ?? '',
        };
      }),
    );
  }

  private async request<T>(
    method: string,
    path: string,
    data?: unknown,
    options?: RequestOptions,
  ): Promise<Either<APIError, T>> {
    let attempts = 0;
    const requestConfig: AxiosRequestConfig = {
      method,
      url: path,
      data,
      ...options,
    };

    while (attempts < this.retry.attempts) {
      try {
        const response = await this.client.request<T>(requestConfig);
        return right(response.data);
      } catch (error) {
        attempts++;
        const apiError =
          error instanceof APIError
            ? error
            : axios.isAxiosError(error)
              ? APIError.fromAxiosError(error)
              : error instanceof Error
                ? APIError.fromError(error)
                : new APIError('Unknown error occurred', HTTP_CONFIG.ERROR.UNKNOWN_ERROR);

        if (attempts === this.retry.attempts || !this.retry.shouldRetry(apiError)) {
          return left(apiError);
        }

        const delay = this.calculateRetryDelay(attempts);
        await this.delay(delay);
      }
    }

    return left(
      new APIError(
        'Maximum retry attempts exceeded',
        HTTP_CONFIG.ERROR.RETRY_EXHAUSTED,
        HTTP_CONFIG.STATUS.SERVER_ERROR_MIN,
      ),
    );
  }

  private calculateRetryDelay(attempt: number): number {
    const exponentialDelay = this.retry.baseDelay * Math.pow(2, attempt - 1);
    const jitter = Math.random() * HTTP_CONFIG.RETRY.JITTER_MAX;
    return Math.min(exponentialDelay + jitter, this.retry.maxDelay);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
