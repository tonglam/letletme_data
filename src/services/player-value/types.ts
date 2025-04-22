import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { ServiceError } from 'src/types/error.type';

import { PlayerValues, PlayerValueChanges } from '../../types/domain/player-value.type';

export interface PlayerValueServiceOperations {
  readonly detectPlayerValueChanges: (
    enrichedSourceValues: PlayerValues,
  ) => TE.TaskEither<ServiceError, PlayerValueChanges>;
  readonly findPlayerValuesByChangeDate: (
    changeDate: string,
  ) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly findPlayerValuesByElement: (
    element: number,
  ) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly findPlayerValuesByTeam: (team: number) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerValueService {
  readonly getPlayerValuesByChangeDate: (
    changeDate: string,
  ) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly getPlayerValuesByElement: (element: number) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly getPlayerValuesByTeam: (team: number) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerValueWorkflowsOperations {
  readonly syncPlayerValues: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
