import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { FPL_API_CONFIG } from '../../../../config/api/api.config';
import { ElementSummaryResponseSchema } from '../../../../types/element-summary.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { createApiCallContext } from '../../common/logs';
import { logFplCall } from '../logger';
import { ElementEndpoints, validateEndpointResponse } from '../types';

export const createElementEndpoints = (client: HTTPClient): ElementEndpoints => ({
  getElementSummary: async (elementId: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.element.summary({ elementId }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(ElementSummaryResponseSchema)),
      logFplCall(createApiCallContext('getElementSummary', { elementId })),
    );
  },
});
