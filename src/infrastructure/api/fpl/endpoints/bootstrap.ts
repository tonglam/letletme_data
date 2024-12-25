import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { BootStrapResponse, BootStrapResponseSchema } from '../../../../types/bootStrap.type';
import { HTTPClient } from '../../common/client';
import { APIError } from '../../common/errors';
import { createApiCallContext } from '../../common/logs';
import { RequestOptions } from '../../common/types';
import { FPL_API_CONFIG } from '../config';
import { logFplCall, validateResponse } from '../utils';

type BootstrapEndpoints = {
  getBootstrapStatic(options?: RequestOptions): Promise<E.Either<APIError, BootStrapResponse>>;
};

export const createBootstrapEndpoints = (client: HTTPClient): BootstrapEndpoints => ({
  getBootstrapStatic: async (options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.bootstrap.static as string, options)();
    return pipe(
      result,
      E.chain(validateResponse(BootStrapResponseSchema)),
      logFplCall(createApiCallContext('getBootstrapStatic')),
    );
  },
});
