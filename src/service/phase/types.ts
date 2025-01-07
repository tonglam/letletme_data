import { ExtendedBootstrapApi } from 'domains/bootstrap/types';
import * as TE from 'fp-ts/TaskEither';
import type { ServiceError } from '../../types/error.type';
import type { Phase, PhaseId, Phases } from '../../types/phase.type';

/**
 * Public interface for the phase service.
 * Provides high-level operations for phase management.
 */
export interface PhaseService {
  readonly getPhases: () => TE.TaskEither<ServiceError, Phases>;
  readonly getPhase: (id: PhaseId) => TE.TaskEither<ServiceError, Phase | null>;
  readonly savePhases: (phases: Phases) => TE.TaskEither<ServiceError, Phases>;
  readonly syncPhasesFromApi: () => TE.TaskEither<ServiceError, Phases>;
}

/**
 * Complete phase service interface including workflows.
 * This is the public interface exposed to consumers.
 */
export interface PhaseServiceWithWorkflows extends PhaseService {
  readonly workflows: {
    readonly syncPhases: () => TE.TaskEither<ServiceError, WorkflowResult<Phases>>;
  };
}

/**
 * External dependencies required by the phase service.
 */
export interface PhaseServiceDependencies {
  readonly bootstrapApi: ExtendedBootstrapApi;
}

/**
 * Internal operations used by the service implementation.
 * Maps closely to domain operations but with service-level error handling.
 */
export interface PhaseServiceOperations {
  readonly findAllPhases: () => TE.TaskEither<ServiceError, Phases>;
  readonly findPhaseById: (id: PhaseId) => TE.TaskEither<ServiceError, Phase | null>;
  readonly syncPhasesFromApi: (
    bootstrapApi: PhaseServiceDependencies['bootstrapApi'],
  ) => TE.TaskEither<ServiceError, Phases>;
}

/**
 * Context for tracking workflow execution.
 */
export interface WorkflowContext {
  readonly workflowId: string;
  readonly startTime: Date;
}

/**
 * Generic result type for workflow operations.
 * Includes execution context and metrics.
 */
export interface WorkflowResult<T> {
  readonly context: WorkflowContext;
  readonly result: T;
  readonly duration: number;
}
