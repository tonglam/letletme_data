import { URL } from '../common/types';

/**
 * FPL API Configuration
 * Contains all API endpoints and base URLs for the Fantasy Premier League API
 */

// Base URL constants
export const BASE_URLS = {
  FPL: 'https://fantasy.premierleague.com/api',
} as const;

export interface FPLClientConfig {
  readonly baseURL?: URL;
  readonly userAgent?: string;
}

export const DEFAULT_CONFIG: FPLClientConfig = {
  baseURL: BASE_URLS.FPL,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export type BaseURL = (typeof BASE_URLS)[keyof typeof BASE_URLS];

export interface APIEndpointParams {
  readonly event?: number;
  readonly entry?: number;
  readonly element?: number;
  readonly photoId?: number;
  readonly leagueId?: number;
  readonly page?: number;
}

export type EndpointKeys = keyof APIEndpointParams;
export type Endpoint<P extends EndpointKeys> = (params: Pick<APIEndpointParams, P>) => string;

export interface APIEndpointConfig {
  readonly [key: string]: string | Endpoint<EndpointKeys>;
}

export interface APIConfig {
  readonly baseUrl: BaseURL;
  readonly endpoints: {
    readonly [category: string]: APIEndpointConfig;
  };
}

export const validateConfig = (config: APIConfig): void => {
  if (!Object.keys(BASE_URLS).includes(config.baseUrl)) {
    throw new Error(`Invalid base URL: ${config.baseUrl}`);
  }
  if (!config.endpoints || Object.keys(config.endpoints).length === 0) {
    throw new Error('Endpoints configuration is required');
  }
};

/**
 * Standard FPL API endpoint configuration
 */
export const FPL_API_CONFIG = {
  bootstrap: {
    static: '/bootstrap-static/',
    gameweek: (params: { event: number }): string => {
      return `${BASE_URLS.FPL}/bootstrap-static/${params.event}`;
    },
  },
  fixtures: {
    byGameweek: (params: { event: number }): string => {
      return `${BASE_URLS.FPL}/fixtures/?event=${params.event}`;
    },
    live: (params: { event: number }): string => {
      return `${BASE_URLS.FPL}/event/${params.event}/live/`;
    },
  },
} as const;
