import { AxiosRequestConfig } from 'axios';
import { pipe } from 'fp-ts/function';

import { DEFAULT_CONFIG } from '../../configs/http/http.config';

const addDefaultHeaders = (config: AxiosRequestConfig): AxiosRequestConfig => ({
  ...config,
  headers: {
    ...DEFAULT_CONFIG.headers,
    ...config.headers,
  },
});

const addTimeout = (config: AxiosRequestConfig): AxiosRequestConfig => ({
  ...config,
  timeout: config.timeout || DEFAULT_CONFIG.timeout,
});

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

export const requestInterceptor = (config: AxiosRequestConfig): AxiosRequestConfig =>
  pipe(config, addDefaultHeaders, addTimeout, addCacheBusting);
