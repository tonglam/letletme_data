// API Configuration Module
// Defines the configuration for the FPL API endpoints and parameters.

export const apiConfig = {
  baseUrl: 'https://fantasy.premierleague.com/api',
  endpoints: {
    bootstrap: {
      static: '/bootstrap-static/',
    },
    entry: {
      // Get entry information
      info: (params: { entryId: number }): string => {
        return `/entry/${params.entryId}/`;
      },
      // Get entry transfers
      transfers: (params: { entryId: number }): string => {
        return `/entry/${params.entryId}/transfers/`;
      },
      // Get entry history
      history: (params: { entryId: number }): string => {
        return `/entry/${params.entryId}/history/`;
      },
    },
    event: {
      // Get live event data
      live: (params: { event: number }): string => {
        return `/event/${params.event}/live/`;
      },
      // Get event picks
      picks: (params: { entryId: number; event: number }): string => {
        return `/entry/${params.entryId}/event/${params.event}/picks/`;
      },
      // Get event fixtures
      fixtures: (params: { event: number }): string => {
        return `/fixtures/?event=${params.event}`;
      },
    },
    element: {
      // Get element summary
      summary: (params: { elementId: number }): string => {
        return `/element-summary/${params.elementId}/`;
      },
    },
    leagues: {
      // Get classic league standings
      classic: (params: { leagueId: number; page: number }): string => {
        return `/leagues-classic/${params.leagueId}/standings/?page_standings=${params.page}`;
      },
      // Get H2H league standings
      h2h: (params: { leagueId: number; page: number }): string => {
        return `/leagues-h2h/${params.leagueId}/standings/?page_standings=${params.page}`;
      },
      // Get cup matches
      cup: (params: { leagueId: number; page: number; entryId: number }): string => {
        return `/leagues-h2h-matches/cup/${params.leagueId}?page=${params.page}&entry=${params.entryId}`;
      },
    },
  },
} as const;
