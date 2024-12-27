import axios, { AxiosRequestConfig } from 'axios';
import { ReaderTaskEither } from 'fp-ts/ReaderTaskEither';
import { tryCatch } from 'fp-ts/TaskEither';
import { ErrorCode } from '../../../../config/http/http.error.config';
import { APIError, ERROR_CONFIG, createInternalServerError, isAPIError } from '../errors';
import { HTTPClient, HTTPClientContext, HttpMethod, RequestBody, RequestOptions } from '../types';
import { calculateRetryDelay, delay } from './helpers';

/**
 * Makes an HTTP request with retry mechanism
 */
const makeRequestWithRetry = <T>(
  method: HttpMethod,
  path: string,
  data?: unknown,
  options?: RequestOptions,
): ReaderTaskEither<HTTPClientContext, APIError, T> => {
  return (context) =>
    tryCatch(
      async () => {
        const { client, retryConfig } = context;
        let attempts = 0;
        const requestConfig: AxiosRequestConfig = {
          method,
          url: path,
          data,
          ...options,
        };

        while (attempts < retryConfig.attempts) {
          try {
            const response = await client.request<T>(requestConfig);
            return response.data;
          } catch (error) {
            attempts++;
            const apiError = isAPIError(error)
              ? error
              : axios.isAxiosError(error)
                ? createInternalServerError({
                    message: error.message,
                    details: {
                      response: error.response?.data,
                      code: error.code,
                      status:
                        error.response?.status ??
                        ERROR_CONFIG[ErrorCode.INTERNAL_SERVER_ERROR].httpStatus,
                    },
                  })
                : error instanceof Error
                  ? createInternalServerError({
                      message: error.message,
                      details: { originalError: error },
                    })
                  : createInternalServerError({ message: 'Unknown error occurred' });

            if (attempts === retryConfig.attempts || !retryConfig.shouldRetry(apiError)) {
              throw apiError;
            }

            await delay(calculateRetryDelay(attempts, retryConfig));
          }
        }

        throw createInternalServerError({
          message: 'Maximum retry attempts exceeded',
          details: { attempts: retryConfig.attempts },
        });
      },
      (error) =>
        createInternalServerError({
          message: 'Unexpected error during request',
          details: { error },
        }),
    );
};

/**
 * Creates request functions for each HTTP method
 */
export const createRequestFunctions = (context: HTTPClientContext): HTTPClient => ({
  get: <T>(path: string, options?: RequestOptions) =>
    makeRequestWithRetry<T>(HttpMethod.GET, path, undefined, options)(context),
  post: <T, D = unknown>(path: string, data?: RequestBody<D>, options?: RequestOptions) =>
    makeRequestWithRetry<T>(HttpMethod.POST, path, data, options)(context),
  put: <T, D = unknown>(path: string, data?: RequestBody<D>, options?: RequestOptions) =>
    makeRequestWithRetry<T>(HttpMethod.PUT, path, data, options)(context),
  patch: <T, D = unknown>(path: string, data?: RequestBody<D>, options?: RequestOptions) =>
    makeRequestWithRetry<T>(HttpMethod.PATCH, path, data, options)(context),
  delete: <T>(path: string, options?: RequestOptions) =>
    makeRequestWithRetry<T>(HttpMethod.DELETE, path, undefined, options)(context),
  head: (path: string, options?: RequestOptions) =>
    makeRequestWithRetry<Record<string, string>>(
      HttpMethod.HEAD,
      path,
      undefined,
      options,
    )(context),
  options: (path: string, options?: RequestOptions) =>
    makeRequestWithRetry<Record<string, string>>(
      HttpMethod.OPTIONS,
      path,
      undefined,
      options,
    )(context),
  trace: <T>(path: string, options?: RequestOptions) =>
    makeRequestWithRetry<T>(HttpMethod.TRACE, path, undefined, options)(context),
  connect: <T>(path: string, options?: RequestOptions) =>
    makeRequestWithRetry<T>(HttpMethod.CONNECT, path, undefined, options)(context),
  request: <T, D = unknown>(
    method: HttpMethod,
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => makeRequestWithRetry<T>(method, path, data, options)(context),
});
