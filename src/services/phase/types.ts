import * as TE from 'fp-ts/TaskEither';
import type { WorkflowResult } from 'services/types';
import { ServiceError } from 'src/types/error.type';

import type { FplBootstrapDataService } from '../../data/types';
import type { Phase, PhaseId, Phases } from '../../types/domain/phase.type';

export interface PhaseService {
  readonly getPhases: () => TE.TaskEither<ServiceError, Phases>;
  readonly getPhase: (id: PhaseId) => TE.TaskEither<ServiceError, Phase | null>;
  readonly syncPhasesFromApi: () => TE.TaskEither<ServiceError, Phases>;
}

export interface PhaseServiceWithWorkflows extends PhaseService {
  readonly workflows: {
    readonly syncPhases: () => TE.TaskEither<ServiceError, WorkflowResult<Phases>>;
  };
}

export interface PhaseServiceOpDependencies {
  readonly fplDataService: FplBootstrapDataService;
}

export interface PhaseServiceOperations {
  readonly findAllPhases: () => TE.TaskEither<ServiceError, Phases>;
  readonly findPhaseById: (id: PhaseId) => TE.TaskEither<ServiceError, Phase | null>;
  readonly syncPhasesFromApi: () => TE.TaskEither<ServiceError, Phases>;
}
