import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Logger } from 'pino';
import { BootStrapResponseSchema } from 'src/data/fpl/schemas/bootstrap/bootstrap.schema';

import { apiConfig } from '../../../../configs/api/api.config';
import { APIErrorCode, createAPIError } from '../../../../types/error.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { BootstrapEndpoints } from '../types';

export const createBootstrapEndpoints = (
  client: HTTPClient,
  logger: Logger,
): BootstrapEndpoints => ({
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
                details: {
                  errors: parsed.error.errors,
                  response: JSON.stringify(response, null, 2),
                },
              },
              success: false,
            },
            'FPL API response validation failed',
          );
          return E.left(
            createAPIError({
              code: APIErrorCode.VALIDATION_ERROR,
              message: 'Invalid response data from FPL API',
              details: {
                validationError: parsed.error,
                response: JSON.stringify(response, null, 2),
              },
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
