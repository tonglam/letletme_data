import axios from 'axios';
import { apiConfig } from '../../../configs/api/api.config';
import { DEFAULT_CONFIG } from '../../../configs/http/http.config';
import { getFplApiLogger } from '../../logger';
import { createHTTPClient } from '../client';
import { HTTPClientContext, RetryConfig } from '../client/types';
import { DEFAULT_RETRY_CONFIG } from '../client/utils';
import { createFPLEndpoints } from './endpoints';
import { FPLEndpoints } from './types';

interface FPLClientConfig {
  readonly retryConfig?: Partial<RetryConfig>;
}

export const createFPLClient = (config?: FPLClientConfig): FPLEndpoints => {
  const logger = getFplApiLogger();
  const axiosInstance = axios.create({
    baseURL: apiConfig.baseUrl,
    timeout: DEFAULT_CONFIG.timeout,
    headers: DEFAULT_CONFIG.headers,
  });

  const httpClient = createHTTPClient({
    client: axiosInstance,
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      ...config?.retryConfig,
    },
    logger,
  } satisfies HTTPClientContext);

  return createFPLEndpoints(httpClient, logger);
};
