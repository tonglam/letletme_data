import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { Phases } from 'src/types/domain/phase.type';

import { PhaseCreateInputs } from '../../repositories/phase/type';
import { DomainError } from '../../types/error.type';

export interface PhaseCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface PhaseCache {
  readonly getAllPhases: () => TE.TaskEither<DomainError, Phases>;
  readonly setAllPhases: (phases: Phases) => TE.TaskEither<DomainError, void>;
  readonly deleteAllPhases: () => TE.TaskEither<DomainError, void>;
}

export interface PhaseOperations {
  readonly savePhases: (phases: PhaseCreateInputs) => TE.TaskEither<DomainError, Phases>;
  readonly deleteAllPhases: () => TE.TaskEither<DomainError, void>;
}
