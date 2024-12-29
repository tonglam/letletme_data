import { FPLClientConfig } from '../../infrastructure/http/fpl/types';

/**
 * Base URLs for different API endpoints
 * @const {Readonly<{FPL: string}>}
 */
export const BASE_URLS = {
  FPL: 'https://fantasy.premierleague.com/api',
} as const;

/**
 * Default HTTP client configuration for FPL API
 * @const {FPLClientConfig}
 */
export const DEFAULT_CONFIG: FPLClientConfig = {
  baseURL: BASE_URLS.FPL,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/**
 * Security configuration for API endpoints
 * @const {Readonly<{RATE_LIMIT: {WINDOW_MS: number, MAX_REQUESTS: number, MESSAGE: string}, CORS: object, HELMET: object}>}
 */
export const SECURITY_CONFIG = {
  RATE_LIMIT: {
    WINDOW_MS: 15 * 60 * 1000,
    MAX_REQUESTS: 100,
    MESSAGE: 'Too many requests from this IP, please try again later',
  },
  CORS: {
    // Add CORS configuration if needed
  },
  HELMET: {
    // Add Helmet configuration if needed
  },
} as const;

/**
 * API validation error configuration
 * @const {Readonly<{ERROR_CODES: {VALIDATION_ERROR: number, SYSTEM_ERROR: number}, ERROR_MESSAGES: {SYSTEM_ERROR: string}}>}
 */
export const VALIDATION_CONFIG = {
  ERROR_CODES: {
    VALIDATION_ERROR: 400,
    SYSTEM_ERROR: 500,
  },
  ERROR_MESSAGES: {
    SYSTEM_ERROR: 'Internal server error occurred',
  },
} as const;

/**
 * FPL API endpoint configuration
 * Contains all endpoint paths and path generators for the Fantasy Premier League API
 * @const
 */
export const FPL_API_CONFIG = {
  bootstrap: {
    static: '/bootstrap-static/',
  },
  entry: {
    /**
     * @param {Object} params - Entry parameters
     * @param {number} params.entryId - FPL entry/team ID
     * @returns {string} Formatted API endpoint
     */
    info: (params: { entryId: number }): string => {
      return `/entry/${params.entryId}/`;
    },
    /**
     * @param {Object} params - Entry parameters
     * @param {number} params.entryId - FPL entry/team ID
     * @returns {string} Formatted API endpoint
     */
    transfers: (params: { entryId: number }): string => {
      return `/entry/${params.entryId}/transfers/`;
    },
    /**
     * @param {Object} params - Entry parameters
     * @param {number} params.entryId - FPL entry/team ID
     * @returns {string} Formatted API endpoint
     */
    history: (params: { entryId: number }): string => {
      return `/entry/${params.entryId}/history/`;
    },
  },
  leagues: {
    /**
     * @param {Object} params - League parameters
     * @param {number} params.leagueId - Classic league ID
     * @param {number} params.page - Page number for pagination
     * @returns {string} Formatted API endpoint
     */
    classic: (params: { leagueId: number; page: number }): string => {
      return `/leagues-classic/${params.leagueId}/standings/?page_standings=${params.page}`;
    },
    /**
     * @param {Object} params - League parameters
     * @param {number} params.leagueId - Head-to-head league ID
     * @param {number} params.page - Page number for pagination
     * @returns {string} Formatted API endpoint
     */
    h2h: (params: { leagueId: number; page: number }): string => {
      return `/leagues-h2h/${params.leagueId}/standings/?page_standings=${params.page}`;
    },
    /**
     * @param {Object} params - Cup parameters
     * @param {number} params.leagueId - League ID
     * @param {number} params.page - Page number for pagination
     * @param {number} params.entryId - FPL entry/team ID
     * @returns {string} Formatted API endpoint
     */
    cup: (params: { leagueId: number; page: number; entryId: number }): string => {
      return `/leagues-h2h-matches/league/${params.leagueId}/?page=${params.page}&entry=${params.entryId}`;
    },
  },
  event: {
    /**
     * @param {Object} params - Event parameters
     * @param {number} params.event - Gameweek number
     * @returns {string} Formatted API endpoint
     */
    live: (params: { event: number }): string => {
      return `/event/${params.event}/live/`;
    },
    /**
     * @param {Object} params - Event parameters
     * @param {number} params.entryId - FPL entry/team ID
     * @param {number} params.event - Gameweek number
     * @returns {string} Formatted API endpoint
     */
    picks: (params: { entryId: number; event: number }): string => {
      return `/entry/${params.entryId}/event/${params.event}/picks/`;
    },
    /**
     * @param {Object} params - Event parameters
     * @param {number} params.event - Gameweek number
     * @returns {string} Formatted API endpoint
     */
    fixtures: (params: { event: number }): string => {
      return `/fixtures/?event=${params.event}`;
    },
  },
  element: {
    /**
     * @param {Object} params - Element parameters
     * @param {number} params.elementId - Player element ID
     * @returns {string} Formatted API endpoint
     */
    summary: (params: { elementId: number }): string => {
      return `/element-summary/${params.elementId}/`;
    },
  },
  resources: {
    /**
     * @param {Object} params - Resource parameters
     * @param {number} params.photoId - Player photo ID
     * @returns {string} Formatted URL for player photo
     */
    playerPhoto: (params: { photoId: number }): string => {
      return `https://resources.premierleague.com/premierleague/photos/players/110x140/p${params.photoId}.png`;
    },
  },
} as const;
