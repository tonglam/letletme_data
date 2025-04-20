import axios, { AxiosRequestConfig } from 'axios';
import * as TE from 'fp-ts/TaskEither';

import { HTTPClient, HTTPClientContext, HttpMethod, RequestBody, RequestOptions } from './types';
import { calculateRetryDelay, createErrorFromStatus, createMonitor, delay } from './utils';
import { HTTP_STATUS } from '../../configs/http/http.config';
import { APIError } from '../../types/error.type';

const makeRequestWithRetry = <T>(
  context: HTTPClientContext,
  method: HttpMethod,
  path: string,
  data?: unknown,
  options?: RequestOptions,
): TE.TaskEither<APIError, T> =>
  TE.tryCatch(
    async () => {
      const { client, retryConfig, logger } = context;
      let attempts = 0;
      const requestConfig: AxiosRequestConfig = {
        method,
        url: path,
        data,
        ...options,
      };

      const monitor = createMonitor();

      while (attempts < retryConfig.attempts) {
        try {
          const response = await client.request<T>(requestConfig);
          const metrics = monitor.end(path, method, {
            status: response.status,
          });
          logger.info({ metrics }, 'Request completed successfully');
          return response.data;
        } catch (error) {
          attempts++;
          if (axios.isAxiosError(error)) {
            const status = error.response?.status ?? HTTP_STATUS.SERVICE_UNAVAILABLE;
            const apiError = createErrorFromStatus(status, error.message, {
              response: error.response?.data,
              code: error.code,
            });

            if (!retryConfig.shouldRetry(apiError) || attempts === retryConfig.attempts) {
              const metrics = monitor.end(path, method, {
                status,
                error: apiError,
              });
              logger.error({ error: apiError, metrics }, 'Request failed');
              throw apiError;
            }

            const retryDelay = calculateRetryDelay(attempts, retryConfig);
            logger.warn({ attempt: attempts, delay: retryDelay }, 'Request failed, retrying...');
            await delay(retryDelay);
          } else {
            const apiError = createErrorFromStatus(
              HTTP_STATUS.SERVICE_UNAVAILABLE,
              error instanceof Error ? error.message : 'Unknown error',
            );
            const metrics = monitor.end(path, method, {
              status: HTTP_STATUS.SERVICE_UNAVAILABLE,
              error: apiError,
            });
            logger.error({ error: apiError, metrics }, 'Request failed');
            throw apiError;
          }
        }
      }

      const exhaustedError = createErrorFromStatus(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        'Retry attempts exhausted',
      );
      const metrics = monitor.end(path, method, {
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
        error: exhaustedError,
      });
      logger.error({ error: exhaustedError, metrics }, 'Retry attempts exhausted');
      throw exhaustedError;
    },
    (error) =>
      error instanceof Error && 'code' in error
        ? (error as APIError)
        : createErrorFromStatus(
            HTTP_STATUS.SERVICE_UNAVAILABLE,
            error instanceof Error ? error.message : 'Unknown error',
          ),
  );

/**
 * Creates an HTTP client instance with the provided context
 */
export const createHTTPClient = (context: HTTPClientContext): HTTPClient => ({
  get: <T>(path: string, options?: RequestOptions) =>
    makeRequestWithRetry<T>(context, HttpMethod.GET, path, undefined, options),

  post: <T, D = unknown>(path: string, data?: RequestBody<D>, options?: RequestOptions) =>
    makeRequestWithRetry<T>(context, HttpMethod.POST, path, data, options),

  put: <T, D = unknown>(path: string, data?: RequestBody<D>, options?: RequestOptions) =>
    makeRequestWithRetry<T>(context, HttpMethod.PUT, path, data, options),

  patch: <T, D = unknown>(path: string, data?: RequestBody<D>, options?: RequestOptions) =>
    makeRequestWithRetry<T>(context, HttpMethod.PATCH, path, data, options),

  delete: <T>(path: string, options?: RequestOptions) =>
    makeRequestWithRetry<T>(context, HttpMethod.DELETE, path, undefined, options),

  head: (path: string, options?: RequestOptions) =>
    makeRequestWithRetry<Record<string, string>>(
      context,
      HttpMethod.HEAD,
      path,
      undefined,
      options,
    ),

  options: (path: string, options?: RequestOptions) =>
    makeRequestWithRetry<Record<string, string>>(
      context,
      HttpMethod.OPTIONS,
      path,
      undefined,
      options,
    ),

  trace: <T>(path: string, options?: RequestOptions) =>
    makeRequestWithRetry<T>(context, HttpMethod.TRACE, path, undefined, options),

  connect: <T>(path: string, options?: RequestOptions) =>
    makeRequestWithRetry<T>(context, HttpMethod.CONNECT, path, undefined, options),

  request: <T, D = unknown>(
    method: HttpMethod,
    path: string,
    data?: RequestBody<D>,
    options?: RequestOptions,
  ) => makeRequestWithRetry<T>(context, method, path, data, options),
});
