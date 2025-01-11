import * as TE from 'fp-ts/TaskEither';
import { ExtendedBootstrapApi } from '../../domain/bootstrap/types';
import { ServiceError } from '../../types/error.type';
import { Player, PlayerId, Players } from '../../types/player.type';
import { Team } from '../../types/team.type';

export type EnhancedPlayers = readonly EnhancedPlayer[];

/**
 * Public interface for the player service.
 * Provides high-level operations for player management.
 */
export interface PlayerService {
  readonly getPlayers: () => TE.TaskEither<ServiceError, EnhancedPlayers>;
  readonly getPlayer: (id: PlayerId) => TE.TaskEither<ServiceError, Player | null>;
  readonly savePlayers: (players: Players) => TE.TaskEither<ServiceError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<ServiceError, Players>;
  readonly findPlayerById: (id: PlayerId) => TE.TaskEither<ServiceError, EnhancedPlayer | null>;
}

/**
 * Complete player service interface including workflows.
 * This is the public interface exposed to consumers.
 */
export interface PlayerServiceWithWorkflows extends PlayerService {
  readonly workflows: {
    readonly syncPlayers: () => TE.TaskEither<ServiceError, WorkflowResult<Players>>;
  };
}

/**
 * External dependencies required by the player service.
 */
export interface PlayerServiceDependencies {
  readonly bootstrapApi: ExtendedBootstrapApi;
  readonly teamService: {
    readonly getTeam: (id: number) => TE.TaskEither<ServiceError, Team | null>;
  };
}

/**
 * Internal operations used by the service implementation.
 * Maps closely to domain operations but with service-level error handling.
 */
export interface PlayerServiceOperations {
  readonly findAllPlayers: () => TE.TaskEither<ServiceError, EnhancedPlayers>;
  readonly findPlayerById: (id: PlayerId) => TE.TaskEither<ServiceError, EnhancedPlayer | null>;
  readonly syncPlayersFromApi: (
    bootstrapApi: PlayerServiceDependencies['bootstrapApi'],
  ) => TE.TaskEither<ServiceError, Players>;
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
  readonly result: T;
  readonly duration: number;
}

/**
 * Enhanced player type with team information
 */
export interface EnhancedPlayer extends Omit<Player, 'teamId' | 'elementType'> {
  readonly elementType: string;
  readonly team: {
    readonly id: number;
    readonly name: string;
    readonly shortName: string;
  };
}
