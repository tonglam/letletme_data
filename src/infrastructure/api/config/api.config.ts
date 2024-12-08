/**
 * FPL API Configuration
 * Contains all API endpoints and base URLs for the Fantasy Premier League API
 */

// Base URL constants
export const BASE_URLS = {
  FPL: 'https://fantasy.premierleague.com/api',
  FPL_CHALLENGE: 'https://fplchallenge.premierleague.com/api',
  FPL_RESOURCE: 'https://resources.premierleague.com',
} as const;

// Type definitions
export type BaseURL = keyof typeof BASE_URLS;
export type EndpointKeys = keyof URLParams;
export type Endpoint<P extends EndpointKeys> = (params: Pick<URLParams, P>) => string;

export interface URLParams {
  readonly event: number;
  readonly entry: number;
  readonly element: number;
  readonly photoId: number;
  readonly leagueId: number;
  readonly page: number;
  readonly phase: number;
}

export interface APIEndpointConfig {
  readonly [key: string]: string | Endpoint<EndpointKeys>;
}

export interface APIConfig {
  readonly baseUrl: BaseURL;
  readonly endpoints: {
    readonly [category: string]: APIEndpointConfig;
  };
}

// Validation functions
export const validateURLParams = (params: Partial<URLParams>): void => {
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && typeof value !== 'number') {
      throw new Error(`Invalid parameter: ${key} must be a number`);
    }
    if (value !== undefined && value < 0) {
      throw new Error(`Invalid parameter: ${key} must be non-negative`);
    }
  }
};

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
 * All endpoints are type-safe and documented
 */
export const FPL_API_CONFIG = {
  bootstrap: {
    static: `${BASE_URLS.FPL}/bootstrap-static/`,
    gameweek: (params: Pick<URLParams, 'event'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/bootstrap-static/${params.event}`;
    },
  },

  fixtures: {
    byGameweek: (params: Pick<URLParams, 'event'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/fixtures/?event=${params.event}`;
    },
    live: (params: Pick<URLParams, 'event'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/event/${params.event}/live/`;
    },
  },

  player: {
    summary: (params: Pick<URLParams, 'element'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/element-summary/${params.element}/`;
    },
    photo: (params: Pick<URLParams, 'photoId'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL_RESOURCE}/premierleague/photos/players/110x140/p${params.photoId}.png`;
    },
  },

  entry: {
    details: (params: Pick<URLParams, 'entry'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/entry/${params.entry}/`;
    },
    history: (params: Pick<URLParams, 'entry'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/entry/${params.entry}/history/`;
    },
    picks: (params: Pick<URLParams, 'entry' | 'event'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/entry/${params.entry}/event/${params.event}/picks/`;
    },
    transfers: (params: Pick<URLParams, 'entry'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/entry/${params.entry}/transfers/`;
    },
  },

  league: {
    classic: (params: Pick<URLParams, 'leagueId' | 'page'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/leagues-classic/${params.leagueId}/standings/?page_standings=${params.page}`;
    },
    headToHead: (params: Pick<URLParams, 'leagueId' | 'page'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL}/leagues-h2h/${params.leagueId}/standings/?page_standings=${params.page}`;
    },
  },
} as const;

/**
 * FPL Challenge API endpoint configuration
 * All endpoints are type-safe and documented
 */
export const CHALLENGE_API_CONFIG = {
  bootstrap: {
    static: `${BASE_URLS.FPL_CHALLENGE}/bootstrap-static/`,
    gameweek: (params: Pick<URLParams, 'event'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL_CHALLENGE}/bootstrap-static/${params.event}`;
    },
  },

  fixtures: {
    byGameweek: (params: Pick<URLParams, 'event'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL_CHALLENGE}/fixtures/?event=${params.event}`;
    },
  },

  entry: {
    details: (params: Pick<URLParams, 'entry' | 'event' | 'phase'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL_CHALLENGE}/entry/${params.entry}/?event=${params.event}&phase=${params.phase}`;
    },
    picks: (params: Pick<URLParams, 'entry' | 'event'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL_CHALLENGE}/entry/${params.entry}/event/${params.event}/picks/`;
    },
    transfers: (params: Pick<URLParams, 'entry'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL_CHALLENGE}/entry/${params.entry}/transfers/`;
    },
  },

  league: {
    standings: (params: Pick<URLParams, 'leagueId' | 'page' | 'phase'>): string => {
      validateURLParams(params);
      return `${BASE_URLS.FPL_CHALLENGE}/leagues-classic/${params.leagueId}/standings/?page_standings=${params.page}&phase=${params.phase}`;
    },
  },
} as const;
