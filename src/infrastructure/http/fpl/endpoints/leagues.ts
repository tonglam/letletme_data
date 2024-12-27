import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import {
  ClassicLeagueResponseSchema,
  CupResponseSchema,
  H2hLeagueResponseSchema,
} from '../../../../types/leagues.type';
import { HTTPClient } from '../../common/client';
import { createApiCallContext } from '../../common/logs';
import { RequestOptions } from '../../common/types';
import { FPL_API_CONFIG } from '../config/api.config';
import { logFplCall } from '../logger';
import { LeaguesEndpoints, validateEndpointResponse } from '../types';

export const createLeaguesEndpoints = (client: HTTPClient): LeaguesEndpoints => ({
  getClassicLeague: async (leagueId: number, page: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.leagues.classic({ leagueId, page }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(ClassicLeagueResponseSchema)),
      logFplCall(createApiCallContext('getClassicLeague', { leagueId, page })),
    );
  },

  getH2hLeague: async (leagueId: number, page: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.leagues.h2h({ leagueId, page }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(H2hLeagueResponseSchema)),
      logFplCall(createApiCallContext('getH2hLeague', { leagueId, page })),
    );
  },

  getCup: async (leagueId: number, page: number, entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.leagues.cup({ leagueId, page, entryId }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(CupResponseSchema)),
      logFplCall(createApiCallContext('getCup', { leagueId, page, entryId })),
    );
  },
});
