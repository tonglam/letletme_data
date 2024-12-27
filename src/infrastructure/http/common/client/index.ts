import axios from 'axios';
import { pipe } from 'fp-ts/function';
import { IOEither, tryCatch as ioTryCatch } from 'fp-ts/IOEither';
import { HTTP_CONFIG } from '../../config/http.config';
import { APIError, createInternalServerError } from '../errors';
import { HTTPClient, HTTPClientConfig, HTTPClientContext } from '../types';
import { createDefaultHeaders, DEFAULT_RETRY_CONFIG } from './helpers';
import { setupRequestInterceptors, setupResponseInterceptors } from './interceptors';
import { createRequestFunctions } from './operations';

/**
 * Creates an axios instance with configuration
 */
const createAxiosInstance = (config: HTTPClientConfig) => {
  const clientConfig = {
    timeout: HTTP_CONFIG.TIMEOUT.DEFAULT,
    validateStatus: (status: number) =>
      status >= HTTP_CONFIG.STATUS.OK_MIN && status < HTTP_CONFIG.STATUS.OK_MAX,
    userAgent: HTTP_CONFIG.HEADERS.DEFAULT_USER_AGENT,
    ...config,
  };

  return axios.create({
    ...clientConfig,
    headers: {
      ...createDefaultHeaders(clientConfig.userAgent),
      ...config.headers,
    },
  });
};

/**
 * Creates an HTTP client with explicit side effects handling
 */
export const createHTTPClient = (config: HTTPClientConfig): IOEither<APIError, HTTPClient> => {
  return pipe(
    ioTryCatch(
      () => {
        const context: HTTPClientContext = {
          config,
          client: createAxiosInstance(config),
          retryConfig: { ...DEFAULT_RETRY_CONFIG, ...config.retry },
          logger: config.logger,
        };

        setupRequestInterceptors(context)();
        setupResponseInterceptors(context)();

        return createRequestFunctions(context);
      },
      (error) =>
        createInternalServerError({
          message: 'Failed to create HTTP client',
          details: { error },
        }),
    ),
  );
};

// Re-export types and utilities
export * from '../types';
export * from './helpers';
