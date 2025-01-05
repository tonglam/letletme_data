/**
 * @module FPL/Endpoints/Bootstrap
 * @description Endpoints for retrieving static FPL game data.
 * This module provides access to the core game data that rarely changes during a season,
 * such as teams, players, game rules, and scoring systems.
 */

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Logger } from 'pino';
import { apiConfig } from '../../../../config/api/api.config';
import { BootStrapResponseSchema } from '../../../../types/bootstrap.type';
import { APIErrorCode, createAPIError } from '../../../../types/errors.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { BootstrapEndpoints } from '../types';

/**
 * Creates endpoints for retrieving static FPL game data
 *
 * @function createBootstrapEndpoints
 * @description Factory function that creates endpoints for accessing static FPL game data.
 * The bootstrap endpoints provide access to core game data that typically remains constant
 * throughout a season, with occasional updates for player status changes.
 *
 * The implementation follows functional programming principles:
 * - Uses fp-ts for error handling and data transformation
 * - Implements proper logging for operations
 * - Validates response data using Zod schemas
 *
 * @param {HTTPClient} client - HTTP client for making API requests
 * @param {Logger} logger - Logger instance for operation logging
 * @returns {BootstrapEndpoints} Object containing bootstrap-related endpoints
 */
export const createBootstrapEndpoints = (
  client: HTTPClient,
  logger: Logger,
): BootstrapEndpoints => ({
  /**
   * Retrieves static game data including teams, players, and game rules
   *
   * @function getBootstrapStatic
   * @description Fetches the core FPL game data including:
   * - Player information (name, team, position, stats)
   * - Team information (name, short name, strength)
   * - Game rules and scoring systems
   * - Current gameweek information
   *
   * This data forms the foundation for most FPL operations and should be
   * cached appropriately due to its relatively static nature.
   *
   * @param {RequestOptions} [options] - Optional HTTP request configuration
   * @returns {Promise<Either<APIError, BootStrapResponse>>} Either an error or the bootstrap data
   */
  getBootstrapStatic: async (options?: RequestOptions) => {
    logger.info(
      { operation: 'getBootstrapStatic', url: apiConfig.endpoints.bootstrap.static },
      'Fetching bootstrap data from FPL API',
    );

    const result = await client.get<unknown>(apiConfig.endpoints.bootstrap.static, options)();

    return pipe(
      result,
      E.mapLeft((error) => {
        logger.error(
          {
            operation: 'getBootstrapStatic',
            error: {
              message: error.message,
              code: error.code,
              details: error.details,
              cause: error.cause,
            },
            success: false,
          },
          'FPL API call failed',
        );
        return error;
      }),
      E.chain((response) => {
        const parsed = BootStrapResponseSchema.safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'getBootstrapStatic',
              error: {
                message: 'Invalid response data',
                code: 'VALIDATION_ERROR',
                details: parsed.error,
              },
              success: false,
            },
            'FPL API response validation failed',
          );
          return E.left(
            createAPIError({
              code: APIErrorCode.VALIDATION_ERROR,
              message: 'Invalid response data from FPL API',
              details: { validationError: parsed.error },
            }),
          );
        }

        logger.info(
          {
            operation: 'getBootstrapStatic',
            success: true,
            eventCount: parsed.data.events.length,
            teamCount: parsed.data.teams.length,
            elementCount: parsed.data.elements.length,
          },
          'FPL API call successful',
        );

        return E.right(parsed.data);
      }),
    );
  },
});
