import { ExtendedBootstrapApi } from 'domains/bootstrap/types';
import * as TE from 'fp-ts/TaskEither';
import type { ServiceError } from '../../types/error.type';
import type { PlayerValue, PlayerValueId, PlayerValues } from '../../types/player-value.type';

/**
 * Public interface for the player value service.
 * Provides high-level operations for player value management.
 */
export interface PlayerValueService {
  readonly getPlayerValues: () => TE.TaskEither<ServiceError, PlayerValues>;
  readonly getPlayerValue: (id: PlayerValueId) => TE.TaskEither<ServiceError, PlayerValue | null>;
  readonly savePlayerValues: (values: PlayerValues) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, PlayerValues>;
}

/**
 * Complete player value service interface including workflows.
 * This is the public interface exposed to consumers.
 */
export interface PlayerValueServiceWithWorkflows extends PlayerValueService {
  readonly workflows: {
    readonly syncPlayerValues: () => TE.TaskEither<ServiceError, WorkflowResult<PlayerValues>>;
  };
}

/**
 * External dependencies required by the player value service.
 */
export interface PlayerValueServiceDependencies {
  readonly bootstrapApi: ExtendedBootstrapApi;
}

/**
 * Internal operations used by the service implementation.
 * Maps closely to domain operations but with service-level error handling.
 */
export interface PlayerValueServiceOperations {
  readonly findAllPlayerValues: () => TE.TaskEither<ServiceError, PlayerValues>;
  readonly findPlayerValueById: (
    id: PlayerValueId,
  ) => TE.TaskEither<ServiceError, PlayerValue | null>;
  readonly syncPlayerValuesFromApi: (
    bootstrapApi: PlayerValueServiceDependencies['bootstrapApi'],
  ) => TE.TaskEither<ServiceError, PlayerValues>;
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
