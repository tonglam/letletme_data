/**
 * Player Service Workflow Module
 * Implements high-level workflows that orchestrate multiple player service operations.
 * Provides logging, error handling, and workflow context management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getWorkflowLogger } from '../../infrastructure/logger';
import { ServiceError, ServiceErrorCode, createServiceError } from '../../types/error.type';
import type { Players } from '../../types/player.type';
import type { PlayerService, WorkflowContext, WorkflowResult } from './types';

const logger = getWorkflowLogger();

/**
 * Creates workflow context for tracking and logging
 */
const createWorkflowContext = (workflowId: string): WorkflowContext => ({
  workflowId,
  startTime: new Date(),
});

/**
 * Creates player workflow operations.
 * Implements high-level workflows that combine multiple service operations.
 */
export const playerWorkflows = (playerService: PlayerService) => {
  /**
   * Syncs players from FPL API to local database.
   * Handles logging, error mapping, and workflow context.
   */
  const syncPlayers = (): TE.TaskEither<ServiceError, WorkflowResult<Players>> => {
    const context = createWorkflowContext('player-sync');

    logger.info({ workflow: context.workflowId }, 'Starting player sync workflow');

    return pipe(
      playerService.syncPlayersFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Player sync workflow failed: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((players) => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            count: players.length,
            durationMs: duration,
          },
          'Player sync workflow completed successfully',
        );

        return {
          context,
          result: players,
          duration,
        };
      }),
    );
  };

  return {
    syncPlayers,
  } as const;
};

export type PlayerWorkflows = ReturnType<typeof playerWorkflows>;
