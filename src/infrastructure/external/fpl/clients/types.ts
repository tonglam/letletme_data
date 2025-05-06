import { RawEntryEventPicks } from '@app/domain/models/entry-event-pick.model';
import { RawEntryEventTransfers } from '@app/domain/models/entry-event-transfer.model';
import { EntryHistoryInfos } from '@app/domain/models/entry-history-info.model';
import { EntryInfo } from '@app/domain/models/entry-info.model';
import { EntryLeagueInfos } from '@app/domain/models/entry-league-info.model';
import { RawEventFixtures } from '@app/domain/models/event-fixture.model';
import { EventLiveExplains } from '@app/domain/models/event-live-explain.model';
import { RawEventLives } from '@app/domain/models/event-live.model';
import { RawEventOverallResult } from '@app/domain/models/event-overall-result.model';
import { Events } from '@app/domain/models/event.type';
import { ClassicLeague, H2hLeague, LeagueId } from '@app/domain/models/league.model';
import { PhasesModel } from '@app/domain/models/phase.model';
import { RawPlayerStats } from '@app/domain/models/player-stat.model';
import { PlayerValueTracks } from '@app/domain/models/player-value-track.model';
import { SourcePlayerValues } from '@app/domain/models/player-value.model';
import { RawPlayers } from '@app/domain/models/player.model';
import { EntryID, EventID } from '@app/domain/shared/types/id.types';
import { TeamCreateInputs } from '@app/infrastructure/persistence/drizzle/repositories/team/types';
import { DataLayerError } from '@app/types/error.types';
import * as TE from 'fp-ts/TaskEither';

export interface FplBootstrapDataService {
  readonly getEvents: () => TE.TaskEither<DataLayerError, Events>;
  readonly getPhases: () => TE.TaskEither<DataLayerError, PhasesModel>;
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
