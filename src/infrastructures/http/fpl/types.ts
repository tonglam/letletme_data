import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { BootStrapResponse } from 'src/data/fpl/schemas/bootstrap/bootstrap.schema';
import { z } from 'zod';
import { ElementSummaryResponse } from '../../../types/element-summary.type';
import {
  EntryHistoryResponse,
  EntryResponse,
  EntryTransfersResponse,
} from '../../../types/entry.type';
import { APIError, APIErrorCode, createAPIError } from '../../../types/error.type';
import { EventFixture } from '../../../types/event-fixture.type';
import { EventLiveResponse, EventPicksResponse } from '../../../types/event-live.type';
import { ClassicLeagueResponse, CupResponse, H2hLeagueResponse } from '../../../types/league.type';
import { RequestOptions } from '../client/types';

export interface FPLClientConfig {
  baseURL?: string;
  userAgent?: string;
}

export interface APIEndpointParams {
  event?: number;
  entry?: number;
  element?: number;
  photoId?: number;
  leagueId?: number;
  page?: number;
}

export type EndpointKeys = keyof APIEndpointParams;

export type Endpoint<P extends EndpointKeys> = (params: Pick<APIEndpointParams, P>) => string;

export interface APIEndpointConfig {
  readonly [key: string]: string | Endpoint<EndpointKeys>;
}

export interface APIConfig {
  readonly baseUrl: string;
  readonly endpoints: {
    readonly [category: string]: APIEndpointConfig;
  };
}

export interface BootstrapEndpoints {
  readonly getBootstrapStatic: (
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, BootStrapResponse>>;
}

export interface ElementEndpoints {
  readonly getElementSummary: (
    elementId: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, ElementSummaryResponse>>;
}

export interface EntryEndpoints {
  readonly getEntry: (
    entryId: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, EntryResponse>>;
  readonly getEntryTransfers: (
    entryId: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, EntryTransfersResponse>>;
  readonly getEntryHistory: (
    entryId: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, EntryHistoryResponse>>;
}

export interface EventEndpoints {
  readonly getLive: (
    event: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, EventLiveResponse>>;
  readonly getPicks: (
    entryId: number,
    event: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, EventPicksResponse>>;
  readonly getFixtures: (
    event: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, EventFixture[]>>;
}

export interface LeaguesEndpoints {
  readonly getClassicLeague: (
    leagueId: number,
    page: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, ClassicLeagueResponse>>;
  readonly getH2hLeague: (
    leagueId: number,
    page: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, H2hLeagueResponse>>;
  readonly getCup: (
    leagueId: number,
    page: number,
    entryId: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, CupResponse>>;
}

export interface FPLEndpoints {
  readonly bootstrap: BootstrapEndpoints;
  readonly element: ElementEndpoints;
  readonly entry: EntryEndpoints;
  readonly event: EventEndpoints;
  readonly leagues: LeaguesEndpoints;
}

export const validateEndpointResponse =
  <T>(schema: z.ZodType<T>) =>
  (data: unknown): E.Either<APIError, T> =>
    pipe(
      E.tryCatch(
        () => schema.parse(data),
        (error) =>
          createAPIError({
            code: APIErrorCode.VALIDATION_ERROR,
            message: 'Invalid response data',
            details: { error },
          }),
      ),
    );
