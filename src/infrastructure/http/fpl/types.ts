/**
 * @module FPL
 * @description Core types and interfaces for the Fantasy Premier League (FPL) API client.
 * This module provides type definitions for API requests, responses, and client configuration.
 */

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { BootStrapResponse } from '../../../types/bootstrap.type';
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

/**
 * Configuration options for the FPL API client
 * @interface FPLClientConfig
 * @property {string} [baseURL] - Base URL for API requests, defaults to official FPL API if not provided
 * @property {string} [userAgent] - Custom user agent string for API requests
 */
export interface FPLClientConfig {
  baseURL?: string;
  userAgent?: string;
}

/**
 * Common parameters used across various FPL API endpoints
 * @interface APIEndpointParams
 * @property {number} [event] - Event/gameweek ID (1-38 for a regular season)
 * @property {number} [entry] - Team entry ID representing a user's team
 * @property {number} [element] - Player element ID representing a specific player
 * @property {number} [photoId] - Player photo ID for retrieving player images
 * @property {number} [leagueId] - League ID for retrieving league-specific data
 * @property {number} [page] - Page number for paginated results (1-based indexing)
 */
export interface APIEndpointParams {
  event?: number;
  entry?: number;
  element?: number;
  photoId?: number;
  leagueId?: number;
  page?: number;
}

/**
 * Union type of all possible endpoint parameter keys
 * Used for type-safe parameter extraction in endpoint functions
 */
export type EndpointKeys = keyof APIEndpointParams;

/**
 * Type for endpoint URL generator functions
 * @template P - Subset of endpoint parameter keys required by the endpoint
 */
export type Endpoint<P extends EndpointKeys> = (params: Pick<APIEndpointParams, P>) => string;

/**
 * Configuration for individual API endpoints
 * Maps endpoint names to either static URLs or dynamic URL generator functions
 */
export interface APIEndpointConfig {
  readonly [key: string]: string | Endpoint<EndpointKeys>;
}

/**
 * Global API configuration structure
 * @interface APIConfig
 * @property {string} baseUrl - Base URL for all API requests
 * @property {Object} endpoints - Categorized endpoint configurations
 */
export interface APIConfig {
  readonly baseUrl: string;
  readonly endpoints: {
    readonly [category: string]: APIEndpointConfig;
  };
}

// Endpoints for retrieving static FPL game data
export interface BootstrapEndpoints {
  readonly getBootstrapStatic: (
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, BootStrapResponse>>;
}

// Endpoints for retrieving player (element) specific data
export interface ElementEndpoints {
  readonly getElementSummary: (
    elementId: number,
    options?: RequestOptions,
  ) => Promise<E.Either<APIError, ElementSummaryResponse>>;
}

// Endpoints for retrieving team (entry) specific data
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

// Endpoints for retrieving gameweek (event) specific data
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

// Endpoints for retrieving league specific data
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

// Aggregation of all FPL API endpoints
export interface FPLEndpoints {
  readonly bootstrap: BootstrapEndpoints;
  readonly element: ElementEndpoints;
  readonly entry: EntryEndpoints;
  readonly event: EventEndpoints;
  readonly leagues: LeaguesEndpoints;
}

/**
 * Utility function to validate API responses against a Zod schema
 * @template T - Expected response type
 * @param {z.ZodType<T>} schema - Zod schema for response validation
 * @returns {(data: unknown) => E.Either<APIError, T>} Validation function
 */
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
