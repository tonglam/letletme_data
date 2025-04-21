import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { ServiceError } from 'src/types/error.type';

import type { Phase, PhaseId, Phases } from '../../types/domain/phase.type';

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
