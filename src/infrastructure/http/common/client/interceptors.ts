import { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { IO } from 'fp-ts/IO';
import pino, { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { HTTP_CONFIG } from '../../../../config/http/http.config';
import { ErrorCode } from '../../../../config/http/http.error.config';
import { ERROR_CONFIG, createBadRequestError, createInternalServerError } from '../errors';
import { HTTPClientContext } from '../types';
import { createErrorFromStatus } from './helpers';

// Add request ID and timing to Axios config
declare module 'axios' {
  export interface InternalAxiosRequestConfig {
    requestId?: string;
    startTime?: number;
    correlationId?: string;
    metadata?: {
      correlationId: string;
      startTime: number;
    };
  }
}

/**
 * Sets up request interceptors
 */
export const setupRequestInterceptors =
  (context: HTTPClientContext): IO<void> =>
  () => {
    const { client, config } = context;
    const logger = context.logger ?? pino();

    // Add logging interceptor
    client.interceptors.request.use(requestInterceptor(logger), (error: unknown) => {
      logger.error({
        type: 'request_error',
        error: error instanceof Error ? error.message : 'Unknown request error',
        correlationId: error instanceof Error ? error.cause?.toString() : undefined,
      });
      return Promise.reject(error);
    });

    // Add URL processing interceptor
    client.interceptors.request.use(
      (reqConfig: InternalAxiosRequestConfig) => {
        if (!reqConfig.url) {
          throw createBadRequestError({ message: 'URL is required' });
        }

        try {
          const url = new URL(
            reqConfig.url.startsWith('http')
              ? reqConfig.url
              : `${config.baseURL || ''}${reqConfig.url}`,
          );
          url.searchParams.append(HTTP_CONFIG.CACHE.TIMESTAMP_PARAM, Date.now().toString());
          reqConfig.url = url.toString();
        } catch (error) {
          throw createBadRequestError({
            message: 'Invalid URL configuration',
            details: { error },
          });
        }

        return reqConfig;
      },
      (error: unknown) => {
        const apiError =
          error instanceof Error
            ? createErrorFromStatus(ERROR_CONFIG[ErrorCode.BAD_REQUEST].httpStatus, error.message, {
                originalError: error,
              })
            : createInternalServerError({ message: 'Unknown request error' });
        return Promise.reject(apiError);
      },
    );
  };

/**
 * Sets up response interceptors
 */
export const setupResponseInterceptors =
  (context: HTTPClientContext): IO<void> =>
  () => {
    const { client } = context;
    const logger = context.logger ?? pino();

    client.interceptors.response.use(
      responseInterceptor(logger).onFulfilled,
      responseInterceptor(logger).onRejected,
    );
  };

export const requestInterceptor =
  (logger: Logger) =>
  (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
    const correlationId = uuidv4();
    const startTime = Date.now();

    config.metadata = { correlationId, startTime };

    logger.info({
      type: 'external_request',
      method: config.method?.toUpperCase(),
      url: config.url,
      params: config.params,
      correlationId,
    });

    return config;
  };

export const responseInterceptor = (logger: Logger) => ({
  onFulfilled: (response: AxiosResponse): AxiosResponse => {
    const { config } = response;
    const { correlationId, startTime } = config.metadata || {};
    const duration = startTime ? Date.now() - startTime : undefined;

    logger.info({
      type: 'external_response',
      url: config.url,
      status: response.status,
      duration,
      correlationId,
    });

    return response;
  },
  onRejected: (error: unknown): Promise<never> => {
    const { config, response } = error as {
      config?: InternalAxiosRequestConfig;
      response?: AxiosResponse;
    };
    const { correlationId, startTime } = config?.metadata || {};
    const duration = startTime ? Date.now() - startTime : undefined;

    logger.error({
      type: 'external_response',
      url: config?.url,
      status: response?.status,
      error: error instanceof Error ? error.message : 'Unknown error',
      duration,
      correlationId,
    });

    return Promise.reject(error);
  },
});
