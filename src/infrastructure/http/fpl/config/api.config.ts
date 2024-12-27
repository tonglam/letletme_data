import { FPLClientConfig } from '../types';

/**
 * FPL API Configuration
 * Contains all API endpoints and base URLs for the Fantasy Premier League API
 */

// Base URL constants
export const BASE_URLS = {
  FPL: 'https://fantasy.premierleague.com/api',
} as const;

// Default client configuration
export const DEFAULT_CONFIG: FPLClientConfig = {
  baseURL: BASE_URLS.FPL,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/**
 * Standard FPL API endpoint configuration
 */
export const FPL_API_CONFIG = {
  bootstrap: {
    static: '/bootstrap-static/',
  },
  entry: {
    info: (params: { entryId: number }): string => {
      return `/entry/${params.entryId}/`;
    },
    transfers: (params: { entryId: number }): string => {
      return `/entry/${params.entryId}/transfers/`;
    },
    history: (params: { entryId: number }): string => {
      return `/entry/${params.entryId}/history/`;
    },
  },
  leagues: {
    classic: (params: { leagueId: number; page: number }): string => {
      return `/leagues-classic/${params.leagueId}/standings/?page_standings=${params.page}`;
    },
    h2h: (params: { leagueId: number; page: number }): string => {
      return `/leagues-h2h/${params.leagueId}/standings/?page_standings=${params.page}`;
    },
    cup: (params: { leagueId: number; page: number; entryId: number }): string => {
      return `/leagues-h2h-matches/league/${params.leagueId}/?page=${params.page}&entry=${params.entryId}`;
    },
  },
  event: {
    live: (params: { event: number }): string => {
      return `/event/${params.event}/live/`;
    },
    picks: (params: { entryId: number; event: number }): string => {
      return `/entry/${params.entryId}/event/${params.event}/picks/`;
    },
    fixtures: (params: { event: number }): string => {
      return `/fixtures/?event=${params.event}`;
    },
  },
  element: {
    summary: (params: { elementId: number }): string => {
      return `/element-summary/${params.elementId}/`;
    },
  },
  resources: {
    playerPhoto: (params: { photoId: number }): string => {
      return `https://resources.premierleague.com/premierleague/photos/players/110x140/p${params.photoId}.png`;
    },
  },
} as const;
