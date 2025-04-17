import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { Phase, PhaseId, Phases } from 'src/types/domain/phase.type';

import { PrismaPhaseCreate } from '../../repositories/phase/type';
import { DBError, DomainError } from '../../types/error.type';

// ============ Repository Types ============

export interface PhaseRepository {
  readonly findAll: () => TE.TaskEither<DBError, Phases>;
  readonly findById: (id: PhaseId) => TE.TaskEither<DBError, Phase | null>;
  readonly saveBatch: (phases: readonly PrismaPhaseCreate[]) => TE.TaskEither<DBError, Phases>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}

// ============ Cache Types ============

export interface PhaseCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface PhaseCache {
  readonly getPhase: (id: PhaseId) => TE.TaskEither<DomainError, Phase | null>;
  readonly getAllPhases: () => TE.TaskEither<DomainError, Phases | null>;
  readonly setAllPhases: (phases: Phases) => TE.TaskEither<DomainError, void>;
  readonly deleteAllPhases: () => TE.TaskEither<DomainError, void>;
}

// ============ Operations Types ============

export interface PhaseOperations {
  readonly getAllPhases: () => TE.TaskEither<DomainError, Phases>;
  readonly getPhaseById: (id: PhaseId) => TE.TaskEither<DomainError, Phase | null>;
  readonly savePhases: (phases: readonly PrismaPhaseCreate[]) => TE.TaskEither<DomainError, Phases>;
  readonly deleteAllPhases: () => TE.TaskEither<DomainError, void>;
}
