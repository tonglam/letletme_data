import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { PlayerValues, PlayerValueChanges } from 'types/domain/player-value.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { ServiceError } from 'types/error.type';

export interface PlayerValueServiceOperations {
  readonly detectPlayerValueChanges: (
    enrichedSourceValues: PlayerValues,
  ) => TE.TaskEither<ServiceError, PlayerValueChanges>;
  readonly findPlayerValuesByChangeDate: (
    changeDate: string,
  ) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly findPlayerValuesByElement: (
    elementId: PlayerId,
  ) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly findPlayerValuesByTeam: (teamId: TeamId) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerValueService {
  readonly getPlayerValuesByChangeDate: (
    changeDate: string,
  ) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly getPlayerValuesByElement: (
    elementId: PlayerId,
  ) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly getPlayerValuesByTeam: (teamId: TeamId) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PlayerValueWorkflowsOperations {
  readonly syncPlayerValues: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
