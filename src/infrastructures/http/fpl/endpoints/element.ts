// Element (player) specific endpoints for retrieving player data

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Logger } from 'pino';
import { apiConfig } from '../../../../configs/api/api.config';
import { ElementSummaryResponseSchema } from '../../../../types/element-summary.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { ElementEndpoints, validateEndpointResponse } from '../types';

// Creates endpoints for retrieving player-specific data
export const createElementEndpoints = (client: HTTPClient, logger: Logger): ElementEndpoints => ({
  // Retrieves detailed statistics and information for a specific player
  getElementSummary: async (elementId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      apiConfig.endpoints.element.summary({ elementId }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(ElementSummaryResponseSchema)),
      E.map((data) => {
        logger.info(
          { operation: 'getElementSummary', elementId, success: true },
          'FPL API call successful',
        );
        return data;
      }),
      E.mapLeft((error) => {
        logger.error(
          { operation: 'getElementSummary', elementId, error, success: false },
          'FPL API call failed',
        );
        return error;
      }),
    );
  },
});
