import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { ElementTypeId } from 'types/base.type';
import { Player, Players, PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { ServiceError } from 'types/error.type';

export interface PlayerServiceOperations {
  readonly findPlayerById: (id: PlayerId) => TE.TaskEither<ServiceError, Player>;
  readonly findPlayersByElementType: (
    elementType: ElementTypeId,
  ) => TE.TaskEither<ServiceError, Players>;
  readonly findPlayersByTeam: (teamId: TeamId) => TE.TaskEither<ServiceError, Players>;
  readonly findAllPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerService {
  readonly getPlayer: (id: PlayerId) => TE.TaskEither<ServiceError, Player>;
  readonly getPlayersByElementType: (
    elementType: ElementTypeId,
  ) => TE.TaskEither<ServiceError, Players>;
  readonly getPlayersByTeamId: (teamId: TeamId) => TE.TaskEither<ServiceError, Players>;
  readonly getPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerWorkflowsOperations {
  readonly syncPlayers: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
