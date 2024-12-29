// League specific endpoints for retrieving FPL league data

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Logger } from 'pino';
import { FPL_API_CONFIG } from '../../../../config/api/api.config';
import {
  ClassicLeagueResponseSchema,
  CupResponseSchema,
  H2hLeagueResponseSchema,
} from '../../../../types/leagues.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { LeaguesEndpoints, validateEndpointResponse } from '../types';

// Creates endpoints for retrieving league-specific data
export const createLeaguesEndpoints = (client: HTTPClient, logger: Logger): LeaguesEndpoints => ({
  // Retrieves standings and information for a classic league
  getClassicLeague: async (leagueId: number, page: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.leagues.classic({ leagueId, page }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(ClassicLeagueResponseSchema)),
      E.map((data) => {
        logger.info(
          { operation: 'getClassicLeague', leagueId, page, success: true },
          'FPL API call successful',
        );
        return data;
      }),
      E.mapLeft((error) => {
        logger.error(
          { operation: 'getClassicLeague', leagueId, page, error, success: false },
          'FPL API call failed',
        );
        return error;
      }),
    );
  },

  // Retrieves standings and information for a head-to-head league
  getH2hLeague: async (leagueId: number, page: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.leagues.h2h({ leagueId, page }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(H2hLeagueResponseSchema)),
      E.map((data) => {
        logger.info(
          { operation: 'getH2hLeague', leagueId, page, success: true },
          'FPL API call successful',
        );
        return data;
      }),
      E.mapLeft((error) => {
        logger.error(
          { operation: 'getH2hLeague', leagueId, page, error, success: false },
          'FPL API call failed',
        );
        return error;
      }),
    );
  },

  // Retrieves cup match information for a specific team
  getCup: async (leagueId: number, page: number, entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.leagues.cup({ leagueId, page, entryId }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(CupResponseSchema)),
      E.map((data) => {
        logger.info(
          { operation: 'getCup', leagueId, page, entryId, success: true },
          'FPL API call successful',
        );
        return data;
      }),
      E.mapLeft((error) => {
        logger.error(
          { operation: 'getCup', leagueId, page, entryId, error, success: false },
          'FPL API call failed',
        );
        return error;
      }),
    );
  },
});
