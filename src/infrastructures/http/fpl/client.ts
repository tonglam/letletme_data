/**
 * @module FPL/Client
 * @description Factory module for creating a configured FPL API client.
 * Provides a centralized way to create and configure the FPL API client with proper logging,
 * retry capabilities, and default configurations.
 */

import axios from 'axios';
import { apiConfig } from '../../../configs/api/api.config';
import { DEFAULT_CONFIG } from '../../../configs/http/http.config';
import { getFplApiLogger } from '../../logger';
import { createHTTPClient } from '../client';
import { HTTPClientContext } from '../client/types';
import { DEFAULT_RETRY_CONFIG } from '../client/utils';
import { createFPLEndpoints } from './endpoints';
import { FPLEndpoints } from './types';

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
 * @returns {FPLEndpoints} Object containing all available FPL API endpoints grouped by category
 * @example
 * const fplClient = createFPLClient();
 * const bootstrapData = await fplClient.bootstrap.getBootstrapStatic();
 */
export const createFPLClient = (): FPLEndpoints => {
  const logger = getFplApiLogger();
  const axiosInstance = axios.create({
    baseURL: apiConfig.baseUrl,
    timeout: DEFAULT_CONFIG.timeout,
    headers: DEFAULT_CONFIG.headers,
  });

  // Create HTTP client with FPL-specific configuration
  const httpClient = createHTTPClient({
    client: axiosInstance,
    retryConfig: DEFAULT_RETRY_CONFIG,
    logger,
  } satisfies HTTPClientContext);

  // Create and return all FPL endpoints with the same logger instance
  return createFPLEndpoints(httpClient, logger);
};
