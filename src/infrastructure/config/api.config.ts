import { EntryID, EventID, LeagueID, PlayerID } from '@app/domain/shared/types/id.types';

export const apiConfig = {
  baseUrl: 'https://fantasy.premierleague.com/api',
  endpoints: {
    bootstrap: {
      static: '/bootstrap-static/',
    },

    event: {
      live: (params: { eventId: EventID }): string => {
        return `/event/${params.eventId}/live/`;
      },
      fixtures: (params: { eventId: EventID }): string => {
        return `/fixtures/?event=${params.eventId}`;
      },
    },

    entry: {
      info: (params: { entryId: EntryID }): string => {
        return `/entry/${params.entryId}/`;
      },
      history: (params: { entryId: EntryID }): string => {
        return `/entry/${params.entryId}/history/`;
      },
      picks: (params: { entryId: EntryID; eventId: EventID }): string => {
        return `/entry/${params.entryId}/event/${params.eventId}/picks/`;
      },
      transfers: (params: { entryId: EntryID; eventId: EventID }): string => {
        return `/entry/${params.entryId}/event/${params.eventId}/transfers/`;
      },
    },

    element: {
      summary: (params: { elementId: PlayerID }): string => {
        return `/element-summary/${params.elementId}/`;
      },
    },

    leagues: {
      classic: (params: { leagueId: LeagueID; page: number }): string => {
        return `/leagues-classic/${params.leagueId}/standings/?page_standings=${params.page}`;
      },
      h2h: (params: { leagueId: LeagueID; page: number }): string => {
        return `/leagues-h2h/${params.leagueId}/standings/?page_standings=${params.page}`;
      },
      cup: (params: { leagueId: LeagueID; page: number; entryId: EntryID }): string => {
        return `/leagues-h2h-matches/cup/${params.leagueId}?page=${params.page}&entry=${params.entryId}`;
      },
    },
  },
} as const;
