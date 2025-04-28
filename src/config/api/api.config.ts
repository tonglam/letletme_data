import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { LeagueId } from 'types/domain/league.type';
import { PlayerId } from 'types/domain/player.type';

export const apiConfig = {
  baseUrl: 'https://fantasy.premierleague.com/api',
  endpoints: {
    bootstrap: {
      static: '/bootstrap-static/',
    },

    event: {
      live: (params: { eventId: EventId }): string => {
        return `/event/${params.eventId}/live/`;
      },
      fixtures: (params: { eventId: EventId }): string => {
        return `/fixtures/?event=${params.eventId}`;
      },
    },

    entry: {
      info: (params: { entryId: EntryId }): string => {
        return `/entry/${params.entryId}/`;
      },
      history: (params: { entryId: EntryId }): string => {
        return `/entry/${params.entryId}/history/`;
      },
      picks: (params: { entryId: EntryId; eventId: EventId }): string => {
        return `/entry/${params.entryId}/event/${params.eventId}/picks/`;
      },
      transfers: (params: { entryId: EntryId; eventId: EventId }): string => {
        return `/entry/${params.entryId}/event/${params.eventId}/transfers/`;
      },
    },

    element: {
      summary: (params: { elementId: PlayerId }): string => {
        return `/element-summary/${params.elementId}/`;
      },
    },

    leagues: {
      classic: (params: { leagueId: LeagueId; page: number }): string => {
        return `/leagues-classic/${params.leagueId}/standings/?page_standings=${params.page}`;
      },
      h2h: (params: { leagueId: LeagueId; page: number }): string => {
        return `/leagues-h2h/${params.leagueId}/standings/?page_standings=${params.page}`;
      },
      cup: (params: { leagueId: LeagueId; page: number; entryId: EntryId }): string => {
        return `/leagues-h2h-matches/cup/${params.leagueId}?page=${params.page}&entry=${params.entryId}`;
      },
    },
  },
} as const;
