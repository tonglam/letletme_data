import * as TE from 'fp-ts/TaskEither';
import type { WorkflowResult } from 'services/types';
import { FplBootstrapDataService } from 'src/data/types';
import { PlayerStat, PlayerStatId, PlayerStats } from 'src/types/domain/player-stat.type';
import { ServiceError } from 'src/types/error.type';

export interface PlayerStatService {
  readonly getPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly getPlayerStat: (id: PlayerStatId) => TE.TaskEither<ServiceError, PlayerStat | null>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<ServiceError, PlayerStats>;
}

export interface PlayerStatServiceWithWorkflows extends PlayerStatService {
  readonly workflows: {
    readonly syncPlayerStats: () => TE.TaskEither<ServiceError, WorkflowResult<PlayerStats>>;
  };
}

export interface PlayerStatServiceOpDependencies {
  readonly fplDataService: FplBootstrapDataService;
}

export interface PlayerStatServiceOperations {
  readonly findAllPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly findPlayerStatById: (id: PlayerStatId) => TE.TaskEither<ServiceError, PlayerStat | null>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<ServiceError, PlayerStats>;
}
