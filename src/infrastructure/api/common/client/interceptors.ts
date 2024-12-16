import axios, { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { IO } from 'fp-ts/IO';
import { HTTP_CONFIG } from '../../config/http.config';
import { ErrorCode } from '../../config/http.error.config';
import { ERROR_CONFIG, createBadRequestError, createInternalServerError } from '../errors';
import { HTTPClientContext } from '../Types';
import { createErrorFromStatus } from './helpers';

/**
 * Sets up request interceptors
 */
export const setupRequestInterceptors =
  (context: HTTPClientContext): IO<void> =>
  () => {
    const { client, config } = context;

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

    client.interceptors.response.use(
      (response: AxiosResponse) => response,
      (error: unknown) => {
        const apiError = axios.isAxiosError(error)
          ? createErrorFromStatus(
              error.response?.status ?? ERROR_CONFIG[ErrorCode.INTERNAL_SERVER_ERROR].httpStatus,
              error.message,
              {
                response: error.response?.data,
                code: error.code,
              },
            )
          : error instanceof Error
            ? createInternalServerError({
                message: error.message,
                details: { originalError: error },
              })
            : createInternalServerError({ message: 'Unknown response error' });
        return Promise.reject(apiError);
      },
    );
  };
