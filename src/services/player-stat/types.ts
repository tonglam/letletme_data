import * as TE from 'fp-ts/TaskEither';
import { PlayerStat, PlayerStats } from 'src/types/domain/player-stat.type';
import { ServiceError } from 'src/types/error.type';

import type { WorkflowResult } from 'services/types';

export interface PlayerStatServiceOperations {
  readonly findPlayerStat: (element: number) => TE.TaskEither<ServiceError, PlayerStat>;
  readonly findPlayerStatsByElementType: (
    elementType: number,
  ) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly findPlayerStatsByTeam: (team: number) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly findAllPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerStatService {
  readonly getPlayerStat: (element: number) => TE.TaskEither<ServiceError, PlayerStat>;
  readonly getPlayerStatsByElementType: (
    elementType: number,
  ) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly getPlayerStatsByTeam: (team: number) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly getPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerStatWorkflowsOperations {
  readonly syncPlayerStats: () => TE.TaskEither<ServiceError, WorkflowResult<PlayerStats>>;
}
