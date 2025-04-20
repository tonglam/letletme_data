import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { ServiceError } from 'src/types/error.type';

import { PlayerValue, PlayerValueId, PlayerValues } from '../../types/domain/player-value.type';

export interface PlayerValueServiceOperations {
  readonly findAllPlayerValues: () => TE.TaskEither<ServiceError, PlayerValues>;
  readonly findPlayerValueById: (id: PlayerValueId) => TE.TaskEither<ServiceError, PlayerValue>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, PlayerValues>;
}

export interface PlayerValueService {
  readonly getPlayerValues: () => TE.TaskEither<ServiceError, PlayerValues>;
  readonly getPlayerValue: (id: PlayerValueId) => TE.TaskEither<ServiceError, PlayerValue>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, PlayerValues>;
}

export interface PlayerValueWorkflowsOperations {
  readonly syncPlayerValues: () => TE.TaskEither<ServiceError, WorkflowResult<PlayerValues>>;
}
