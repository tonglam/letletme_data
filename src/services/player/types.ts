import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { FplBootstrapDataService } from 'src/data/types';
import { Player, PlayerId, Players } from 'src/types/domain/player.type';
import { ServiceError } from 'src/types/error.type';

export interface PlayerService {
  readonly getPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly getPlayer: (id: PlayerId) => TE.TaskEither<ServiceError, Player | null>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, Players>;
}

export interface PlayerServiceWithWorkflows extends PlayerService {
  readonly workflows: {
    readonly syncPlayers: () => TE.TaskEither<ServiceError, WorkflowResult<Players>>;
  };
}

export interface PlayerServiceOpDependencies {
  readonly fplDataService: FplBootstrapDataService;
}

export interface PlayerServiceOperations {
  readonly findAllPlayers: () => TE.TaskEither<ServiceError, Players>;
  readonly findPlayerById: (id: PlayerId) => TE.TaskEither<ServiceError, Player | null>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, Players>;
}
