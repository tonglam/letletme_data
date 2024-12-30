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
  },
} as const;
