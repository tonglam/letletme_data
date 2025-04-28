import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { Phase, PhaseId, Phases } from 'types/domain/phase.type';
import { ServiceError } from 'types/error.type';

export interface PhaseServiceOperations {
  readonly findPhaseById: (id: PhaseId) => TE.TaskEither<ServiceError, Phase>;
  readonly findAllPhases: () => TE.TaskEither<ServiceError, Phases>;
  readonly syncPhasesFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PhaseService {
  readonly getPhase: (id: PhaseId) => TE.TaskEither<ServiceError, Phase>;
  readonly getPhases: () => TE.TaskEither<ServiceError, Phases>;
  readonly syncPhasesFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface PhaseWorkflowOperations {
  readonly syncPhases: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
