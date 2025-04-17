import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Logger } from 'pino';

import { apiConfig } from '../../../../configs/api/api.config';
import {
  EntryHistoryResponseSchema,
  EntryResponseSchema,
  EntryTransfersResponseSchema,
} from '../../../../types/entry.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { EntryEndpoints, validateEndpointResponse } from '../types';

export const createEntryEndpoints = (client: HTTPClient, logger: Logger): EntryEndpoints => ({
  getEntry: async (entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      apiConfig.endpoints.entry.info({ entryId }),
      options,
    )();
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

  getEntryTransfers: async (entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      apiConfig.endpoints.entry.transfers({ entryId }),
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

  getEntryHistory: async (entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      apiConfig.endpoints.entry.history({ entryId }),
      options,
    )();
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
