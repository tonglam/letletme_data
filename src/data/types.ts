import * as TE from 'fp-ts/TaskEither';
import { EntryEventPicks } from 'src/types/domain/entry-event-pick.type';
import { EntryEventTransfers } from 'src/types/domain/entry-event-transfer.type';
import { EntryHistoryInfos } from 'src/types/domain/entry-history-info.type';
import { EntryInfos } from 'src/types/domain/entry-info.type';
import { EntryLeagueInfos } from 'src/types/domain/entry-league-info.type';
import { EventFixtures } from 'src/types/domain/event-fixture.type';
import { EventLiveExplains } from 'src/types/domain/event-live-explain.type';
import { EventLives } from 'src/types/domain/event-live.type';
import { Events } from 'src/types/domain/event.type';
import { Phases } from 'src/types/domain/phase.type';
import { PlayerStats } from 'src/types/domain/player-stat.type';
import { PlayerValues } from 'src/types/domain/player-value.type';
import { Players } from 'src/types/domain/player.type';
import { Teams } from 'src/types/domain/team.type';
import { DataLayerError } from 'src/types/error.type';

export interface FplBootstrapDataService {
  readonly getEvents: () => TE.TaskEither<DataLayerError, Events>;
  readonly getPhases: () => TE.TaskEither<DataLayerError, Phases>;
  readonly getTeams: () => TE.TaskEither<DataLayerError, Teams>;
  readonly getPlayers: () => TE.TaskEither<DataLayerError, Players>;
  readonly getPlayerStats: (eventId: number) => TE.TaskEither<DataLayerError, PlayerStats>;
  readonly getPlayerValues: (eventId: number) => TE.TaskEither<DataLayerError, PlayerValues>;
}

export interface FplFixtureDataService {
  readonly getFixtures: (eventId: number) => TE.TaskEither<DataLayerError, EventFixtures>;
}

export interface FplEventDataService {
  readonly getLives: (eventId: number) => TE.TaskEither<DataLayerError, EventLives>;
  readonly getExplains: (eventId: number) => TE.TaskEither<DataLayerError, EventLiveExplains>;
}

export interface FplEntryDataService {
  readonly getEntryInfos: (entryId: number) => TE.TaskEither<DataLayerError, EntryInfos>;
  readonly getEntryLeagues: (entryId: number) => TE.TaskEither<DataLayerError, EntryLeagueInfos>;
}

export interface FplHistoryDataService {
  readonly getHistoryInfos: (entryId: number) => TE.TaskEither<DataLayerError, EntryHistoryInfos>;
}

export interface FplPickDataService {
  readonly getPicks: (
    entryId: number,
    eventId: number,
  ) => TE.TaskEither<DataLayerError, EntryEventPicks>;
}

export interface FplTransferDataService {
  readonly getTransfers: (
    entryId: number,
    eventId: number,
  ) => TE.TaskEither<DataLayerError, EntryEventTransfers>;
}
