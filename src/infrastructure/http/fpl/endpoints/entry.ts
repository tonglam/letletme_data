// Entry (team) specific endpoints for retrieving FPL team data

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Logger } from 'pino';
import { FPL_API_CONFIG } from '../../../../config/api/api.config';
import {
  EntryHistoryResponseSchema,
  EntryResponseSchema,
  EntryTransfersResponseSchema,
} from '../../../../types/entry.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { EntryEndpoints, validateEndpointResponse } from '../types';

// Creates endpoints for retrieving FPL team-specific data
export const createEntryEndpoints = (client: HTTPClient, logger: Logger): EntryEndpoints => ({
  // Retrieves basic information about a specific FPL team
  getEntry: async (entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.entry.info({ entryId }), options)();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EntryResponseSchema)),
      E.map((data) => {
        logger.info({ operation: 'getEntry', entryId, success: true }, 'FPL API call successful');
        return data;
      }),
      E.mapLeft((error) => {
        logger.error(
          { operation: 'getEntry', entryId, error, success: false },
          'FPL API call failed',
        );
        return error;
      }),
    );
  },

  // Retrieves transfer history for a specific FPL team
  getEntryTransfers: async (entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.entry.transfers({ entryId }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EntryTransfersResponseSchema)),
      E.map((data) => {
        logger.info(
          { operation: 'getEntryTransfers', entryId, success: true },
          'FPL API call successful',
        );
        return data;
      }),
      E.mapLeft((error) => {
        logger.error(
          { operation: 'getEntryTransfers', entryId, error, success: false },
          'FPL API call failed',
        );
        return error;
      }),
    );
  },

  // Retrieves gameweek and season history for a specific FPL team
  getEntryHistory: async (entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.entry.history({ entryId }), options)();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EntryHistoryResponseSchema)),
      E.map((data) => {
        logger.info(
          { operation: 'getEntryHistory', entryId, success: true },
          'FPL API call successful',
        );
        return data;
      }),
      E.mapLeft((error) => {
        logger.error(
          { operation: 'getEntryHistory', entryId, error, success: false },
          'FPL API call failed',
        );
        return error;
      }),
    );
  },
});
