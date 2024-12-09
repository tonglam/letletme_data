import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { EventResponseSchema } from '../../../types/events.type';
import { HTTPClient, HTTPClientConfig, RequestOptions } from '../common/client';
import { ValidationError } from '../common/errors';
import { createApiCallContext, createApiLogger, logApiCall } from '../common/logs';
import { APIResponse } from '../common/types';
import { BASE_URLS, FPL_API_CONFIG } from './config';

// Types
export interface FPLClientConfig extends Partial<HTTPClientConfig> {
  readonly userAgent?: string;
}

// Constants
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT = 60000; // 60 seconds

// Utilities
const createDefaultHeaders = (userAgent: string): Record<string, string> => ({
  'User-Agent': userAgent,
  Accept: 'application/json',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
});

const validateResponse =
  <T>(schema: z.ZodType<T>) =>
  (response: unknown): APIResponse<T> => {
    try {
      return E.right(schema.parse(response));
    } catch (error) {
      return E.left(
        new ValidationError(
          `Schema validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { schema: schema.description },
        ),
      );
    }
  };

// Logger setup
const logger = createApiLogger({
  name: 'fpl-api',
  level: 'info',
  filepath: './logs/fpl-api.log',
});
const logFplCall = logApiCall(logger);

/**
 * FPL API Client
 * Handles all Fantasy Premier League API requests with validation and logging
 */
export class FPLClient extends HTTPClient {
  constructor(config?: FPLClientConfig) {
    super({
      baseURL: config?.baseURL ?? BASE_URLS.FPL,
      headers: {
        ...createDefaultHeaders(config?.userAgent ?? DEFAULT_USER_AGENT),
        ...config?.headers,
      },
      timeout: config?.timeout ?? DEFAULT_TIMEOUT,
      retry: {
        attempts: 5,
        baseDelay: 2000,
        maxDelay: 10000,
        shouldRetry: (error) => error instanceof Error && error.name !== 'ValidationError',
      },
      validateStatus: (status: number) => status >= 200 && status < 300,
    });
  }

  /**
   * Bootstrap Static Data
   * Returns all static game data including events, teams, and elements
   */
  async getBootstrapStatic(options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.bootstrap.static, options),
      E.chain(validateResponse(EventResponseSchema)),
      logFplCall(createApiCallContext('getBootstrapStatic')),
    );
  }

  /**
   * Gameweek Fixtures
   * Returns all fixtures for a specific gameweek
   */
  async getFixtures(event: number, options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.fixtures.byGameweek({ event }), options),
      // TODO: Add FixtureResponseSchema validation
      logFplCall(createApiCallContext('getFixtures', { event })),
    );
  }

  /**
   * Live Gameweek Data
   * Returns live player data for a specific gameweek
   */
  async getEventLive(event: number, options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.fixtures.live({ event }), options),
      // TODO: Add EventLiveResponseSchema validation
      logFplCall(createApiCallContext('getEventLive', { event })),
    );
  }

  /**
   * Team Entry Data
   * Returns basic information about a specific team entry
   */
  async getEntry(entry: number, options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.entry.details({ entry }), options),
      // TODO: Add EntryResponseSchema validation
      logFplCall(createApiCallContext('getEntry', { entry })),
    );
  }

  /**
   * Team Entry History
   * Returns historical data for a specific team entry
   */
  async getEntryHistory(entry: number, options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.entry.history({ entry }), options),
      // TODO: Add EntryHistoryResponseSchema validation
      logFplCall(createApiCallContext('getEntryHistory', { entry })),
    );
  }

  /**
   * Player Summary
   * Returns detailed information about a specific player
   */
  async getElementSummary(element: number, options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.player.summary({ element }), options),
      // TODO: Add ElementSummaryResponseSchema validation
      logFplCall(createApiCallContext('getElementSummary', { element })),
    );
  }

  /**
   * Team Picks for Event
   * Returns team selection for a specific gameweek
   */
  async getEntryEventPicks(entry: number, event: number, options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.entry.picks({ entry, event }), options),
      // TODO: Add EntryEventPicksResponseSchema validation
      logFplCall(createApiCallContext('getEntryEventPicks', { entry, event })),
    );
  }

  /**
   * Team Transfers
   * Returns transfer history for a team
   */
  async getEntryTransfers(entry: number, options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.entry.transfers({ entry }), options),
      // TODO: Add EntryTransfersResponseSchema validation
      logFplCall(createApiCallContext('getEntryTransfers', { entry })),
    );
  }

  /**
   * Classic League Standings
   * Returns standings for a classic league
   */
  async getLeagueClassic(leagueId: number, page: number, options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.league.classic({ leagueId, page }), options),
      // TODO: Add LeagueClassicResponseSchema validation
      logFplCall(createApiCallContext('getLeagueClassic', { leagueId, page })),
    );
  }

  /**
   * Head-to-Head League Standings
   * Returns standings for a head-to-head league
   */
  async getLeagueH2H(leagueId: number, page: number, options?: RequestOptions) {
    return pipe(
      await this.get<unknown>(FPL_API_CONFIG.league.headToHead({ leagueId, page }), options),
      // TODO: Add LeagueH2HResponseSchema validation
      logFplCall(createApiCallContext('getLeagueH2H', { leagueId, page })),
    );
  }
}
