import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { EventFixture } from '../../../../types/event-fixture.type';
import {
  EventLiveResponseSchema,
  EventPicksResponseSchema,
} from '../../../../types/event-live.type';
import { HTTPClient } from '../../common/client';
import { createApiCallContext } from '../../common/logs';
import { RequestOptions } from '../../common/types';
import { FPL_API_CONFIG } from '../config/api.config';
import { logFplCall } from '../logger';
import { EventEndpoints, validateEndpointResponse } from '../types';

export const createEventEndpoints = (client: HTTPClient): EventEndpoints => ({
  getLive: async (event: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.event.live({ event }), options)();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EventLiveResponseSchema)),
      logFplCall(createApiCallContext('getLive', { event })),
    );
  },

  getPicks: async (entryId: number, event: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(
      FPL_API_CONFIG.event.picks({ entryId, event }),
      options,
    )();
    return pipe(
      result,
      E.chain(validateEndpointResponse(EventPicksResponseSchema)),
      logFplCall(createApiCallContext('getPicks', { entryId, event })),
    );
  },

  getFixtures: async (event: number, options?: RequestOptions) => {
    const result = await client.get<unknown>(FPL_API_CONFIG.event.fixtures({ event }), options)();
    return pipe(
      result,
      E.chain(validateEndpointResponse(z.array(z.custom<EventFixture>()))),
      logFplCall(createApiCallContext('getFixtures', { event })),
    );
  },
});