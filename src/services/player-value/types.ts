import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { FplBootstrapDataService } from 'src/data/types';
import { ServiceError } from 'src/types/error.type';
import { PlayerValue, PlayerValueId, PlayerValues } from '../../types/domain/player-value.type';

export interface PlayerValueService {
  readonly getPlayerValues: () => TE.TaskEither<ServiceError, PlayerValues>;
  readonly getPlayerValue: (id: PlayerValueId) => TE.TaskEither<ServiceError, PlayerValue | null>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, PlayerValues>;
}

export interface PlayerValueServiceWithWorkflows extends PlayerValueService {
  readonly workflows: {
    readonly syncPlayerValues: () => TE.TaskEither<ServiceError, WorkflowResult<PlayerValues>>;
  };
}

export interface PlayerValueServiceOpDependencies {
  readonly fplDataService: FplBootstrapDataService;
}

export interface PlayerValueServiceOperations {
  readonly findAllPlayerValues: () => TE.TaskEither<ServiceError, PlayerValues>;
  readonly findPlayerValueById: (
    id: PlayerValueId,
  ) => TE.TaskEither<ServiceError, PlayerValue | null>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, PlayerValues>;
}
