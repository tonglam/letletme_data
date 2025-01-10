import * as TE from 'fp-ts/TaskEither';
import { ExtendedBootstrapApi } from '../../domain/bootstrap/types';
import type { ServiceError } from '../../types/error.type';
import type { Team, TeamId, Teams } from '../../types/team.type';

/**
 * Public interface for the team service.
 * Provides high-level operations for team management.
 */
export interface TeamService {
  readonly getTeams: () => TE.TaskEither<ServiceError, Teams>;
  readonly getTeam: (id: TeamId) => TE.TaskEither<ServiceError, Team | null>;
  readonly saveTeams: (teams: Teams) => TE.TaskEither<ServiceError, Teams>;
  readonly syncTeamsFromApi: () => TE.TaskEither<ServiceError, Teams>;
}

/**
 * Complete team service interface including workflows.
 * This is the public interface exposed to consumers.
 */
export interface TeamServiceWithWorkflows extends TeamService {
  readonly workflows: {
    readonly syncTeams: () => TE.TaskEither<ServiceError, WorkflowResult<Teams>>;
  };
}

/**
 * External dependencies required by the team service.
 */
export interface TeamServiceDependencies {
  readonly bootstrapApi: ExtendedBootstrapApi;
}

/**
 * Internal operations used by the service implementation.
 * Maps closely to domain operations but with service-level error handling.
 */
export interface TeamServiceOperations {
  readonly findAllTeams: () => TE.TaskEither<ServiceError, Teams>;
  readonly findTeamById: (id: TeamId) => TE.TaskEither<ServiceError, Team | null>;
  readonly syncTeamsFromApi: (
    bootstrapApi: TeamServiceDependencies['bootstrapApi'],
  ) => TE.TaskEither<ServiceError, Teams>;
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
