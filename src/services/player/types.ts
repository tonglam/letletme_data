import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { Player, PlayerId, Players } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';
import { ServiceError } from 'src/types/error.type';

export interface PlayerServiceOperations {
  readonly findAllPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly findPlayerById: (element: PlayerId) => TE.TaskEither<ServiceError, Player>;
  readonly findPlayerByElementType: (elementType: number) => TE.TaskEither<ServiceError, Players>;
  readonly findPlayerByTeam: (team: TeamId) => TE.TaskEither<ServiceError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerService {
  readonly getPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly getPlayer: (element: PlayerId) => TE.TaskEither<ServiceError, Player>;
  readonly getPlayerByElementType: (elementType: number) => TE.TaskEither<ServiceError, Players>;
  readonly getPlayerByTeam: (team: TeamId) => TE.TaskEither<ServiceError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerWorkflowsOperations {
  readonly syncPlayers: () => TE.TaskEither<ServiceError, WorkflowResult<Players>>;
}
