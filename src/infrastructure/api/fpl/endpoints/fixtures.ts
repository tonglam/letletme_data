import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { Fixture, FixtureSchema } from '../../../../types/fixture.type';
import { HTTPClient } from '../../common/client';
import { APIError } from '../../common/errors';
import { createApiCallContext } from '../../common/logs';
import { RequestOptions } from '../../common/Types';
import { FPL_API_CONFIG } from '../config';
import { logFplCall, validateResponse } from '../utils';

type FixturesEndpoints = {
  getFixtures(event: number, options?: RequestOptions): Promise<E.Either<APIError, Fixture[]>>;
};

export const createFixturesEndpoints = (client: HTTPClient): FixturesEndpoints => ({
  getFixtures: async (event: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.fixtures.byGameweek({ event }),
      options,
    )();
    return pipe(
      result,
      E.chain((data) => validateResponse<Fixture[]>(z.array(FixtureSchema))(data)),
      logFplCall(createApiCallContext('getFixtures', { event })),
    );
  },
});
