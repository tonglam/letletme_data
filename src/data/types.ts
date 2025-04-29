import * as TE from 'fp-ts/TaskEither';
import { RawEntryEventPicks } from 'types/domain/entry-event-pick.type';
import { RawEntryEventTransfers } from 'types/domain/entry-event-transfer.type';
import { EntryHistoryInfos } from 'types/domain/entry-history-info.type';
import { EntryInfos } from 'types/domain/entry-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { RawEventFixtures } from 'types/domain/event-fixture.type';
import { EventLiveExplains } from 'types/domain/event-live-explain.type';
import { RawEventLives } from 'types/domain/event-live.type';
import { RawEventOverallResult } from 'types/domain/event-overall-result.type';
import { EventId, Events } from 'types/domain/event.type';
import { ClassicLeague, H2hLeague, LeagueId } from 'types/domain/league.type';
import { Phases } from 'types/domain/phase.type';
import { RawPlayerStats } from 'types/domain/player-stat.type';
import { PlayerValueTracks } from 'types/domain/player-value-track.type';
import { SourcePlayerValues } from 'types/domain/player-value.type';
import { RawPlayers } from 'types/domain/player.type';
import { Teams } from 'types/domain/team.type';
import { DataLayerError } from 'types/error.type';

export interface FplBootstrapDataService {
  readonly getEvents: () => TE.TaskEither<DataLayerError, Events>;
  readonly getPhases: () => TE.TaskEither<DataLayerError, Phases>;
  readonly getTeams: () => TE.TaskEither<DataLayerError, Teams>;
  readonly getPlayers: () => TE.TaskEither<DataLayerError, RawPlayers>;
  readonly getPlayerStats: (eventId: EventId) => TE.TaskEither<DataLayerError, RawPlayerStats>;
  readonly getPlayerValues: (eventId: EventId) => TE.TaskEither<DataLayerError, SourcePlayerValues>;
  readonly getPlayerValueTracks: (
    eventId: EventId,
  ) => TE.TaskEither<DataLayerError, PlayerValueTracks>;
  readonly getEventOverallResults: (
    eventId: EventId,
  ) => TE.TaskEither<DataLayerError, RawEventOverallResult>;
}

export interface FplFixtureDataService {
  readonly getFixtures: (eventId: EventId) => TE.TaskEither<DataLayerError, RawEventFixtures>;
}

export interface FplLiveDataService {
  readonly getLives: (eventId: EventId) => TE.TaskEither<DataLayerError, RawEventLives>;
  readonly getExplains: (eventId: EventId) => TE.TaskEither<DataLayerError, EventLiveExplains>;
}

export interface FplEntryDataService {
  readonly getInfos: (entryId: EntryId) => TE.TaskEither<DataLayerError, EntryInfos>;
  readonly getLeagues: (entryId: EntryId) => TE.TaskEither<DataLayerError, EntryLeagueInfos>;
}

export interface FplHistoryDataService {
  readonly getHistories: (entryId: EntryId) => TE.TaskEither<DataLayerError, EntryHistoryInfos>;
}

export interface FplPickDataService {
  readonly getPicks: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DataLayerError, RawEntryEventPicks>;
}

export interface FplTransferDataService {
  readonly getTransfers: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DataLayerError, RawEntryEventTransfers>;
}

export interface FplClassicLeagueDataService {
  readonly getClassicLeague: (leagueId: LeagueId) => TE.TaskEither<DataLayerError, ClassicLeague>;
}

export interface FplH2hLeagueDataService {
  readonly getH2hLeague: (leagueId: LeagueId) => TE.TaskEither<DataLayerError, H2hLeague>;
}
