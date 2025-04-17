import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Logger } from 'pino';
import { apiConfig } from '../../../../configs/api/api.config';
import {
  ClassicLeagueResponseSchema,
  CupResponseSchema,
  H2hLeagueResponseSchema,
} from '../../../../types/league.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { LeaguesEndpoints, validateEndpointResponse } from '../types';

export const createLeaguesEndpoints = (client: HTTPClient, logger: Logger): LeaguesEndpoints => ({
  getClassicLeague: async (leagueId: number, page: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      apiConfig.endpoints.leagues.classic({ leagueId, page }),
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

  getH2hLeague: async (leagueId: number, page: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      apiConfig.endpoints.leagues.h2h({ leagueId, page }),
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

  getCup: async (leagueId: number, page: number, entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      apiConfig.endpoints.leagues.cup({ leagueId, page, entryId }),
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
