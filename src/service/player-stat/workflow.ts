/**
 * Player Stat Service Workflow Module
 * Implements high-level workflows that orchestrate multiple player stat service operations.
 * Provides logging, error handling, and workflow context management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getWorkflowLogger } from '../../infrastructure/logger';
import { ServiceError, ServiceErrorCode, createServiceError } from '../../types/error.type';
import type { PlayerStats } from '../../types/player-stat.type';
import type { PlayerStatService, WorkflowContext, WorkflowResult } from './types';

const logger = getWorkflowLogger();

/**
 * Creates workflow context for tracking and logging
 */
const createWorkflowContext = (workflowId: string): WorkflowContext => ({
  workflowId,
  startTime: new Date(),
});

/**
 * Creates player stat workflow operations.
 * Implements high-level workflows that combine multiple service operations.
 */
export const playerStatWorkflows = (playerStatService: PlayerStatService) => {
  /**
   * Syncs player stats from FPL API to local database.
   * Handles logging, error mapping, and workflow context.
   */
  const syncPlayerStats = (): TE.TaskEither<ServiceError, WorkflowResult<PlayerStats>> => {
    const context = createWorkflowContext('player-stat-sync');

    logger.info({ workflow: context.workflowId }, 'Starting player stat sync workflow');

    return pipe(
      playerStatService.syncPlayerStatsFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Player stat sync workflow failed: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((stats) => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            count: stats.length,
            durationMs: duration,
          },
          'Player stat sync workflow completed successfully',
        );

        return {
          context,
          result: stats,
          duration,
        };
      }),
    );
  };

  return {
    syncPlayerStats,
  } as const;
};

export type PlayerStatWorkflows = ReturnType<typeof playerStatWorkflows>;
