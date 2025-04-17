export const apiConfig = {
  baseUrl: 'https://fantasy.premierleague.com/api',
  endpoints: {
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
    leagues: {
      classic: (params: { leagueId: number; page: number }): string => {
        return `/leagues-classic/${params.leagueId}/standings/?page_standings=${params.page}`;
      },
      h2h: (params: { leagueId: number; page: number }): string => {
        return `/leagues-h2h/${params.leagueId}/standings/?page_standings=${params.page}`;
      },
      cup: (params: { leagueId: number; page: number; entryId: number }): string => {
        return `/leagues-h2h-matches/cup/${params.leagueId}?page=${params.page}&entry=${params.entryId}`;
      },
    },
  },
} as const;
