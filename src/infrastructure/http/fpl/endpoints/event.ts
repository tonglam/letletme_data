// Event (gameweek) specific endpoints for retrieving gameweek data

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Logger } from 'pino';
import { z } from 'zod';
import { FPL_API_CONFIG } from '../../../../config/api/api.config';
import { EventFixture } from '../../../../types/event-fixture.type';
import {
  EventLiveResponseSchema,
  EventPicksResponseSchema,
} from '../../../../types/event-live.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { EventEndpoints, validateEndpointResponse } from '../types';

// Creates endpoints for retrieving gameweek-specific data
export const createEventEndpoints = (client: HTTPClient, logger: Logger): EventEndpoints => ({
  // Retrieves live performance data for all players in a specific gameweek
  getLive: async (event: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.event.live({ event }), options)();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EventLiveResponseSchema)),
      E.map((data) => {
        logger.info({ operation: 'getLive', event, success: true }, 'FPL API call successful');
        return data;
      }),
      E.mapLeft((error) => {
        logger.error({ operation: 'getLive', event, error, success: false }, 'FPL API call failed');
        return error;
      }),
    );
  },

  // Retrieves team selection data for a specific team in a gameweek
  getPicks: async (entryId: number, event: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.event.picks({ entryId, event }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EventPicksResponseSchema)),
      E.map((data) => {
        logger.info(
          { operation: 'getPicks', entryId, event, success: true },
          'FPL API call successful',
        );
        return data;
      }),
      E.mapLeft((error) => {
        logger.error(
          { operation: 'getPicks', entryId, event, error, success: false },
          'FPL API call failed',
        );
        return error;
      }),
    );
  },

  // Retrieves fixture data for a specific gameweek
  getFixtures: async (event: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.event.fixtures({ event }), options)();
    return pipe(
      result,
      E.chain(validateEndpointResponse(z.array(z.custom<EventFixture>()))),
      E.map((data) => {
        logger.info({ operation: 'getFixtures', event, success: true }, 'FPL API call successful');
        return data;
      }),
      E.mapLeft((error) => {
        logger.error(
          { operation: 'getFixtures', event, error, success: false },
          'FPL API call failed',
        );
        return error;
      }),
    );
  },
});
