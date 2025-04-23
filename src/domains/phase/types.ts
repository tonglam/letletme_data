import * as TE from 'fp-ts/TaskEither';
import { Phases } from 'src/types/domain/phase.type';

import { PhaseCreateInputs } from '../../repositories/phase/type';
import { DomainError } from '../../types/error.type';

export interface PhaseCacheConfig {
  readonly keyPrefix: string;
  readonly season: string;
}

export interface PhaseCache {
  readonly getAllPhases: () => TE.TaskEither<DomainError, Phases>;
  readonly setAllPhases: (phases: Phases) => TE.TaskEither<DomainError, void>;
}

export interface PhaseOperations {
  readonly savePhases: (phaseInputs: PhaseCreateInputs) => TE.TaskEither<DomainError, Phases>;
  readonly deleteAllPhases: () => TE.TaskEither<DomainError, void>;
}
