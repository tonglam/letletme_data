/**
 * HTTP Request Interceptors
 * @module infrastructure/http/client/request-interceptors
 */

import { AxiosRequestConfig } from 'axios';
import { pipe } from 'fp-ts/function';
import { DEFAULT_CONFIG } from '../../../config/http/http.config';

/**
 * Adds default headers to the request
 */
const addDefaultHeaders = (config: AxiosRequestConfig): AxiosRequestConfig => ({
  ...config,
  headers: {
    ...DEFAULT_CONFIG.headers,
    ...config.headers,
  },
});

/**
 * Adds request timeout
 */
const addTimeout = (config: AxiosRequestConfig): AxiosRequestConfig => ({
  ...config,
  timeout: config.timeout || DEFAULT_CONFIG.timeout,
});

/**
 * Adds cache busting parameters if needed
 */
const addCacheBusting = (config: AxiosRequestConfig): AxiosRequestConfig => {
  if (config.method?.toUpperCase() === 'GET') {
    return {
      ...config,
      params: {
        ...config.params,
        _t: Date.now(),
      },
    };
  }
  return config;
};

/**
 * Composes all request interceptors
 */
export const requestInterceptor = (config: AxiosRequestConfig): AxiosRequestConfig =>
  pipe(config, addDefaultHeaders, addTimeout, addCacheBusting);
