/**
 * Phase Domain Types Module
 *
 * Re-exports core type definitions from the types layer.
 */

import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/config/cache/cache.config';
import { APIError, CacheError, DomainError } from 'src/types/error.type';
import { Phase, PhaseId, PhaseRepository, Phases } from 'src/types/phase.type';
import { BootstrapApi } from '../bootstrap/types';

/**
 * Phase data provider interface
 */
export interface PhaseDataProvider {
  readonly getOne: (id: number) => Promise<Phase | null>;
  readonly getAll: () => Promise<readonly Phase[]>;
}

/**
 * Phase cache configuration interface
 */
export interface PhaseCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

/**
 * Phase cache interface
 */
export interface PhaseCache {
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
  readonly cachePhase: (phase: Phase) => TE.TaskEither<CacheError, void>;
  readonly cachePhases: (phases: readonly Phase[]) => TE.TaskEither<CacheError, void>;
  readonly getPhase: (id: string) => TE.TaskEither<CacheError, Phase | null>;
  readonly getAllPhases: () => TE.TaskEither<CacheError, readonly Phase[]>;
}

/**
 * Phase operations interface for domain logic
 */
export interface PhaseOperations {
  readonly getAllPhases: () => TE.TaskEither<DomainError, Phases>;
  readonly getPhaseById: (id: PhaseId) => TE.TaskEither<DomainError, Phase | null>;
  readonly createPhases: (phases: Phases) => TE.TaskEither<DomainError, Phases>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

/**
 * Service interface for Phase operations
 */
export interface PhaseService {
  readonly getPhases: () => TE.TaskEither<APIError, Phases>;
  readonly getPhase: (id: PhaseId) => TE.TaskEither<APIError, Phase | null>;
  readonly savePhases: (phases: Phases) => TE.TaskEither<APIError, Phases>;
  readonly syncPhasesFromApi: () => TE.TaskEither<APIError, Phases>;
}

/**
 * Dependencies required by the PhaseService
 */
export interface PhaseServiceDependencies {
  bootstrapApi: BootstrapApi;
  phaseCache: PhaseCache;
  phaseRepository: PhaseRepository;
}

export * from '../../types/phase.type';
