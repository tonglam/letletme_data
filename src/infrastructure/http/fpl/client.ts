/**
 * @module FPL/Client
 * @description Factory module for creating a configured FPL API client.
 * Provides a centralized way to create and configure the FPL API client with proper logging,
 * retry capabilities, and default configurations.
 */

import axios from 'axios';
import { apiConfig } from '../../../config/api/api.config';
import { DEFAULT_CONFIG } from '../../../config/http/http.config';
import { getFplApiLogger } from '../../logger';
import { createHTTPClient } from '../client';
import { HTTPClientContext, RetryConfig } from '../client/types';
import { DEFAULT_RETRY_CONFIG } from '../client/utils';
import { createFPLEndpoints } from './endpoints';
import { FPLEndpoints } from './types';

interface FPLClientConfig {
  readonly retryConfig?: Partial<RetryConfig>;
}

/**
 * Creates a fully configured FPL API client with all available endpoints
 *
 * @function createFPLClient
 * @description Initializes an FPL API client with:
 * - Configured axios instance with proper base URL and timeouts
 * - Retry capabilities for failed requests
 * - Structured logging for all API operations
 * - Type-safe endpoint implementations
 *
 * The client follows functional programming principles and uses the fp-ts library
 * for error handling and composition.
 *
 * @param {FPLClientConfig} [config] - Optional client configuration
 * @returns {FPLEndpoints} Object containing all available FPL API endpoints grouped by category
 * @example
 * const fplClient = createFPLClient();
 * const bootstrapData = await fplClient.bootstrap.getBootstrapStatic();
 */
export const createFPLClient = (config?: FPLClientConfig): FPLEndpoints => {
  const logger = getFplApiLogger();
  const axiosInstance = axios.create({
    baseURL: apiConfig.baseUrl,
    timeout: DEFAULT_CONFIG.timeout,
    headers: DEFAULT_CONFIG.headers,
  });

  // Create HTTP client with FPL-specific configuration
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
