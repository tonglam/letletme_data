import * as TE from 'fp-ts/TaskEither';
import { EventFixtures } from 'src/types/domain/event-fixture.type';
import { Events } from 'src/types/domain/event.type';
import { Phases } from 'src/types/domain/phase.type';
import { PlayerStat } from 'src/types/domain/player-stat.type';
import { MappedPlayerValue } from 'src/types/domain/player-value.type';
import { Players } from 'src/types/domain/player.type';
import { Teams } from 'src/types/domain/team.type';
import { DataLayerError } from 'src/types/error.type';

export interface FplBootstrapDataService {
  readonly getEvents: () => TE.TaskEither<DataLayerError, Events>;
  readonly getPhases: () => TE.TaskEither<DataLayerError, Phases>;
  readonly getTeams: () => TE.TaskEither<DataLayerError, Teams>;
  readonly getPlayers: () => TE.TaskEither<DataLayerError, Players>;
  readonly getPlayerStats: (
    eventId: number,
  ) => TE.TaskEither<DataLayerError, readonly Omit<PlayerStat, 'id'>[]>;
  readonly getPlayerValues: (
    eventId: number,
  ) => TE.TaskEither<DataLayerError, readonly MappedPlayerValue[]>;
}

export interface FplEventFixtureDataService {
  readonly getEventFixtures: (eventId: number) => TE.TaskEither<DataLayerError, EventFixtures>;
}
