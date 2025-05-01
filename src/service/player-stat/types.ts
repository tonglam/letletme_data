import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { ElementTypeId } from 'types/base.type';
import { PlayerStat, PlayerStats } from 'types/domain/player-stat.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { ServiceError } from 'types/error.type';

export interface PlayerStatServiceOperations {
  readonly findPlayerStat: (elementId: PlayerId) => TE.TaskEither<ServiceError, PlayerStat>;
  readonly findPlayerStatsByElementType: (
    elementType: ElementTypeId,
  ) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly findPlayerStatsByTeam: (teamId: TeamId) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly findPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerStatService {
  readonly getPlayerStat: (elementId: PlayerId) => TE.TaskEither<ServiceError, PlayerStat>;
  readonly getPlayerStatsByElementType: (
    elementType: ElementTypeId,
  ) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly getPlayerStatsByTeam: (teamId: TeamId) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly getPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerStatWorkflowsOperations {
  readonly syncPlayerStats: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
