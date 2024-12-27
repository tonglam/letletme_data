import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { FPL_API_CONFIG } from '../../../../config/api/api.config';
import {
  EntryHistoryResponseSchema,
  EntryResponseSchema,
  EntryTransfersResponseSchema,
} from '../../../../types/entry.type';
import { HTTPClient } from '../../common/client';
import { createApiCallContext } from '../../common/logs';
import { RequestOptions } from '../../common/types';
import { logFplCall } from '../logger';
import { EntryEndpoints, validateEndpointResponse } from '../types';

export const createEntryEndpoints = (client: HTTPClient): EntryEndpoints => ({
  getEntry: async (entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.entry.info({ entryId }), options)();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EntryResponseSchema)),
      logFplCall(createApiCallContext('getEntry', { entryId })),
    );
  },

  getEntryTransfers: async (entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.entry.transfers({ entryId }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EntryTransfersResponseSchema)),
      logFplCall(createApiCallContext('getEntryTransfers', { entryId })),
    );
  },

  getEntryHistory: async (entryId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.entry.history({ entryId }), options)();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EntryHistoryResponseSchema)),
      logFplCall(createApiCallContext('getEntryHistory', { entryId })),
    );
  },
});
