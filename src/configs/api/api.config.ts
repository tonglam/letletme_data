export const apiConfig = {
  baseUrl: 'https://fantasy.premierleague.com/api',
  endpoints: {
    bootstrap: {
      static: '/bootstrap-static/',
    },

    event: {
      live: (params: { event: number }): string => {
        return `/event/${params.event}/live/`;
      },
      fixtures: (params: { event: number }): string => {
        return `/fixtures/?event=${params.event}`;
      },
    },

    entry: {
      info: (params: { entry: number }): string => {
        return `/entry/${params.entry}/`;
      },
      history: (params: { entry: number }): string => {
        return `/entry/${params.entry}/history/`;
      },
      picks: (params: { entry: number; event: number }): string => {
        return `/entry/${params.entry}/event/${params.event}/picks/`;
      },
      transfers: (params: { entry: number }): string => {
        return `/entry/${params.entry}/transfers/`;
      },
    },

    element: {
      summary: (params: { element: number }): string => {
        return `/element-summary/${params.element}/`;
      },
    },

    leagues: {
      classic: (params: { league: number; page: number }): string => {
        return `/leagues-classic/${params.league}/standings/?page_standings=${params.page}`;
      },
      h2h: (params: { league: number; page: number }): string => {
        return `/leagues-h2h/${params.league}/standings/?page_standings=${params.page}`;
      },
      cup: (params: { league: number; page: number; entry: number }): string => {
        return `/leagues-h2h-matches/cup/${params.league}?page=${params.page}&entry=${params.entry}`;
      },
    },
  },
} as const;
