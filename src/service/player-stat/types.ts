import { ExtendedBootstrapApi } from 'domains/bootstrap/types';
import * as TE from 'fp-ts/TaskEither';
import type { ServiceError } from '../../types/error.type';
import type { PlayerStat, PlayerStatId, PlayerStats } from '../../types/player-stat.type';

/**
 * Public interface for the player stat service.
 * Provides high-level operations for player stat management.
 */
export interface PlayerStatService {
  readonly getPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly getPlayerStat: (id: PlayerStatId) => TE.TaskEither<ServiceError, PlayerStat | null>;
  readonly savePlayerStats: (stats: PlayerStats) => TE.TaskEither<ServiceError, PlayerStats>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<ServiceError, PlayerStats>;
}

/**
 * Complete player stat service interface including workflows.
 * This is the public interface exposed to consumers.
 */
export interface PlayerStatServiceWithWorkflows extends PlayerStatService {
  readonly workflows: {
    readonly syncPlayerStats: () => TE.TaskEither<ServiceError, WorkflowResult<PlayerStats>>;
  };
}

/**
 * External dependencies required by the player stat service.
 */
export interface PlayerStatServiceDependencies {
  readonly bootstrapApi: ExtendedBootstrapApi;
}

/**
 * Internal operations used by the service implementation.
 * Maps closely to domain operations but with service-level error handling.
 */
export interface PlayerStatServiceOperations {
  readonly findAllPlayerStats: () => TE.TaskEither<ServiceError, PlayerStats>;
  readonly findPlayerStatById: (id: PlayerStatId) => TE.TaskEither<ServiceError, PlayerStat | null>;
  readonly syncPlayerStatsFromApi: (
    bootstrapApi: PlayerStatServiceDependencies['bootstrapApi'],
  ) => TE.TaskEither<ServiceError, PlayerStats>;
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
