import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as IOE from 'fp-ts/IOEither';
import { BootStrapResponse } from '../../../types/bootStrap.type';
import { createHTTPClient, HTTPClient } from '../common/client';
import { APIError } from '../common/errors';
import { HTTPClientConfig, RequestOptions, RetryConfig, URL } from '../common/Types';
import { DEFAULT_CONFIG } from './config';
import { createBootstrapEndpoints } from './endpoints';

export interface FPLClientConfig {
  readonly baseURL?: URL;
  readonly userAgent?: string;
}

export interface FPLClient extends HTTPClient {
  getBootstrapStatic(options?: RequestOptions): Promise<E.Either<APIError, BootStrapResponse>>;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  attempts: 5,
  baseDelay: 2000,
  maxDelay: 10000,
  shouldRetry: (error: Error): boolean => error.name !== 'ValidationError',
};

export const createFPLClient = (config?: FPLClientConfig): IOE.IOEither<APIError, FPLClient> => {
  const clientConfig: HTTPClientConfig = {
    baseURL: (config?.baseURL ?? DEFAULT_CONFIG.baseURL) as URL,
    userAgent: config?.userAgent ?? DEFAULT_CONFIG.userAgent,
    timeout: 60000,
    retry: DEFAULT_RETRY_CONFIG,
    validateStatus: (status: number): boolean => status >= 200 && status < 300,
  };

  return pipe(
    createHTTPClient(clientConfig),
    IOE.map(
      (client): FPLClient => ({
        ...client,
        ...createBootstrapEndpoints(client),
      }),
    ),
  );
};
