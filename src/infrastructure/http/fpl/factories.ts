/**
 * @module FPL/Factories
 * @description Factory functions for creating FPL API endpoints.
 * This module provides a centralized way to create and configure all FPL API endpoints
 * with proper dependency injection of HTTP client and logger instances.
 *
 * The factory pattern used here ensures:
 * - Consistent configuration across all endpoints
 * - Proper resource sharing (HTTP client, logger)
 * - Type safety through TypeScript
 * - Functional programming approach with fp-ts
 */

import { Logger } from 'pino';
import { HTTPClient } from '../client';
import { createBootstrapEndpoints } from './endpoints/bootstrap';
import { createElementEndpoints } from './endpoints/element';
import { createEntryEndpoints } from './endpoints/entry';
import { createEventEndpoints } from './endpoints/event';
import { createLeaguesEndpoints } from './endpoints/leagues';
import { FPLEndpoints } from './types';

/**
 * Creates all FPL API endpoints with shared dependencies
 *
 * @function createFPLEndpoints
 * @description Factory function that creates and configures all FPL API endpoints.
 * Each endpoint category (bootstrap, element, entry, event, leagues) is created with
 * shared instances of the HTTP client and logger to ensure consistent behavior
 * and proper resource utilization.
 *
 * The endpoints are created following functional programming principles:
 * - Immutable configurations
 * - Pure functions for API calls
 * - Error handling with Either monad
 *
 * @param {HTTPClient} client - Configured HTTP client for making API requests
 * @param {Logger} logger - Logger instance for endpoint operations
 * @returns {FPLEndpoints} Object containing all configured FPL API endpoints
 *
 * @example
 * const httpClient = createHTTPClient(config);
 * const logger = createLogger();
 * const endpoints = createFPLEndpoints(httpClient, logger);
 *
 * // Use specific endpoint category
 * const bootstrapData = await endpoints.bootstrap.getBootstrapStatic();
 */
export const createFPLEndpoints = (client: HTTPClient, logger: Logger): FPLEndpoints => ({
  bootstrap: createBootstrapEndpoints(client, logger),
  element: createElementEndpoints(client, logger),
  entry: createEntryEndpoints(client, logger),
  event: createEventEndpoints(client, logger),
  leagues: createLeaguesEndpoints(client, logger),
});
