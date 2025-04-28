import * as TE from 'fp-ts/TaskEither';
import { PlayerStat, PlayerStats } from 'types/domain/player-stat.type';
import { PlayerId, PlayerType } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { ServiceError } from 'types/error.type';

import type { WorkflowResult } from 'service/types';

export interface PlayerStatServiceOperations {
  readonly findPlayerStat: (elementId: PlayerId) => TE.TaskEither<ServiceError, PlayerStat>;
  readonly findPlayerStatsByElementType: (
    elementType: PlayerType,
  ) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly findPlayerStatsByTeam: (teamId: TeamId) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly findLatestPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerStatService {
  readonly getPlayerStat: (elementId: PlayerId) => TE.TaskEither<ServiceError, PlayerStat>;
  readonly getPlayerStatsByElementType: (
    elementType: PlayerType,
  ) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly getPlayerStatsByTeam: (teamId: TeamId) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly getLatestPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerStatWorkflowsOperations {
  readonly syncPlayerStats: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
