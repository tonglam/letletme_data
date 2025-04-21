import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { Player, Players } from 'src/types/domain/player.type';
import { ServiceError } from 'src/types/error.type';

export interface PlayerServiceOperations {
  readonly findPlayerById: (element: number) => TE.TaskEither<ServiceError, Player>;
  readonly findPlayersByElementType: (elementType: number) => TE.TaskEither<ServiceError, Players>;
  readonly findPlayersByTeam: (team: number) => TE.TaskEither<ServiceError, Players>;
  readonly findAllPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerService {
  readonly getPlayer: (element: number) => TE.TaskEither<ServiceError, Player>;
  readonly getPlayersByElementType: (elementType: number) => TE.TaskEither<ServiceError, Players>;
  readonly getPlayersByTeam: (team: number) => TE.TaskEither<ServiceError, Players>;
  readonly getPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerWorkflowsOperations {
  readonly syncPlayers: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
