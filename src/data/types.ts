import * as TE from 'fp-ts/TaskEither';
import { EntryEventPicks } from 'src/types/domain/entry-event-pick.type';
import { EntryEventTransfers } from 'src/types/domain/entry-event-transfer.type';
import { EntryHistoryInfos } from 'src/types/domain/entry-history-info.type';
import { EntryInfos } from 'src/types/domain/entry-info.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EntryLeagueInfos } from 'src/types/domain/entry-league-info.type';
import { RawEventFixtures } from 'src/types/domain/event-fixture.type';
import { EventLiveExplains } from 'src/types/domain/event-live-explain.type';
import { RawEventLives } from 'src/types/domain/event-live.type';
import { EventId, Events } from 'src/types/domain/event.type';
import { Phases } from 'src/types/domain/phase.type';
import { RawPlayerStats as RawPlayerStats } from 'src/types/domain/player-stat.type';
import { PlayerValueTracks } from 'src/types/domain/player-value-track.type';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { RawPlayers } from 'src/types/domain/player.type';
import { Teams } from 'src/types/domain/team.type';
import { DataLayerError } from 'src/types/error.type';

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
  ) => TE.TaskEither<DataLayerError, EntryEventPicks>;
}

export interface FplTransferDataService {
  readonly getTransfers: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DataLayerError, EntryEventTransfers>;
}
