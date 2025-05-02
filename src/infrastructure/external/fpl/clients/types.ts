import { EntryID, EventID } from '@app/domain/types/id.types';
import { TeamCreateInputs } from '@app/infrastructure/persistence/drizzle/repository/team/types';
import { RawEntryEventPicks } from '@app/shared/types/domain/entry-event-pick.type';
import { RawEntryEventTransfers } from '@app/shared/types/domain/entry-event-transfer.type';
import { EntryHistoryInfos } from '@app/shared/types/domain/entry-history-info.type';
import { EntryInfo } from '@app/shared/types/domain/entry-info.type';
import { EntryLeagueInfos } from '@app/shared/types/domain/entry-league-info.type';
import { RawEventFixtures } from '@app/shared/types/domain/event-fixture.type';
import { EventLiveExplains } from '@app/shared/types/domain/event-live-explain.type';
import { RawEventLives } from '@app/shared/types/domain/event-live.type';
import { RawEventOverallResult } from '@app/shared/types/domain/event-overall-result.type';
import { Events } from '@app/shared/types/domain/event.type';
import { ClassicLeague, H2hLeague, LeagueId } from '@app/shared/types/domain/league.type';
import { Phases } from '@app/shared/types/domain/phase.type';
import { RawPlayerStats } from '@app/shared/types/domain/player-stat.type';
import { PlayerValueTracks } from '@app/shared/types/domain/player-value-track.type';
import { SourcePlayerValues } from '@app/shared/types/domain/player-value.type';
import { RawPlayers } from '@app/shared/types/domain/player.type';
import { DataLayerError } from '@app/shared/types/error.types';
import * as TE from 'fp-ts/TaskEither';

export interface FplBootstrapDataService {
  readonly getEvents: () => TE.TaskEither<DataLayerError, Events>;
  readonly getPhases: () => TE.TaskEither<DataLayerError, Phases>;
  readonly getTeams: () => TE.TaskEither<DataLayerError, TeamCreateInputs>;
  readonly getPlayers: () => TE.TaskEither<DataLayerError, RawPlayers>;
  readonly getPlayerStats: (eventId: EventID) => TE.TaskEither<DataLayerError, RawPlayerStats>;
  readonly getPlayerValues: (eventId: EventID) => TE.TaskEither<DataLayerError, SourcePlayerValues>;
  readonly getPlayerValueTracks: (
    eventId: EventID,
  ) => TE.TaskEither<DataLayerError, PlayerValueTracks>;
  readonly getEventOverallResults: (
    eventId: EventID,
  ) => TE.TaskEither<DataLayerError, RawEventOverallResult>;
}

export interface FplFixtureDataService {
  readonly getFixtures: (eventId: EventID) => TE.TaskEither<DataLayerError, RawEventFixtures>;
}

export interface FplLiveDataService {
  readonly getLives: (eventId: EventID) => TE.TaskEither<DataLayerError, RawEventLives>;
  readonly getExplains: (eventId: EventID) => TE.TaskEither<DataLayerError, EventLiveExplains>;
}

export interface FplEntryDataService {
  readonly getInfo: (entryId: EntryID) => TE.TaskEither<DataLayerError, EntryInfo>;
  readonly getLeagues: (entryId: EntryID) => TE.TaskEither<DataLayerError, EntryLeagueInfos>;
}

export interface FplHistoryDataService {
  readonly getHistories: (entryId: EntryID) => TE.TaskEither<DataLayerError, EntryHistoryInfos>;
}

export interface FplPickDataService {
  readonly getPicks: (
    entryId: EntryID,
    eventId: EventID,
  ) => TE.TaskEither<DataLayerError, RawEntryEventPicks>;
}

export interface FplTransferDataService {
  readonly getTransfers: (
    entryId: EntryID,
    eventId: EventID,
  ) => TE.TaskEither<DataLayerError, RawEntryEventTransfers>;
}

export interface FplClassicLeagueDataService {
  readonly getClassicLeagueInfo: (
    leagueId: LeagueId,
  ) => TE.TaskEither<DataLayerError, ClassicLeague>;
  readonly getClassicLeague: (leagueId: LeagueId) => TE.TaskEither<DataLayerError, ClassicLeague>;
}

export interface FplH2hLeagueDataService {
  readonly getH2hLeagueInfo: (leagueId: LeagueId) => TE.TaskEither<DataLayerError, H2hLeague>;
  readonly getH2hLeague: (leagueId: LeagueId) => TE.TaskEither<DataLayerError, H2hLeague>;
}
