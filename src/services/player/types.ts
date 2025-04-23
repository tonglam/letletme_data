import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { Player, Players, PlayerId, PlayerType } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';
import { ServiceError } from 'src/types/error.type';

export interface PlayerServiceOperations {
  readonly findPlayerById: (id: PlayerId) => TE.TaskEither<ServiceError, Player>;
  readonly findPlayersByElementType: (
    elementType: PlayerType,
  ) => TE.TaskEither<ServiceError, Players>;
  readonly findPlayersByTeam: (teamId: TeamId) => TE.TaskEither<ServiceError, Players>;
  readonly findAllPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerService {
  readonly getPlayer: (id: PlayerId) => TE.TaskEither<ServiceError, Player>;
  readonly getPlayersByElementType: (
    elementType: PlayerType,
  ) => TE.TaskEither<ServiceError, Players>;
  readonly getPlayersByTeam: (teamId: TeamId) => TE.TaskEither<ServiceError, Players>;
  readonly getPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerWorkflowsOperations {
  readonly syncPlayers: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
