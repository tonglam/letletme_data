import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { PhaseCreateInputs } from 'repository/phase/types';
import { Phases } from 'types/domain/phase.type';
import { DomainError } from 'types/error.type';

export interface PhaseCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface PhaseCache {
  readonly getAllPhases: () => TE.TaskEither<DomainError, Phases>;
  readonly setAllPhases: (phases: Phases) => TE.TaskEither<DomainError, void>;
}

export interface PhaseOperations {
  readonly savePhases: (phaseInputs: PhaseCreateInputs) => TE.TaskEither<DomainError, Phases>;
  readonly deleteAllPhases: () => TE.TaskEither<DomainError, void>;
}
