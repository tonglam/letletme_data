import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { FPL_API_CONFIG } from '../../../../config/api/api.config';
import { BootStrapResponseSchema } from '../../../../types/bootstrap.type';
import { HTTPClient } from '../../client';
import { RequestOptions } from '../../client/types';
import { createApiCallContext } from '../../common/logs';
import { logFplCall } from '../logger';
import { BootstrapEndpoints, validateEndpointResponse } from '../types';

export const createBootstrapEndpoints = (client: HTTPClient): BootstrapEndpoints => ({
  getBootstrapStatic: async (options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.bootstrap.static as string, options)();
    return pipe(
      result,
      E.chain(validateEndpointResponse(BootStrapResponseSchema)),
      logFplCall(createApiCallContext('getBootstrapStatic')),
    );
  },
});
