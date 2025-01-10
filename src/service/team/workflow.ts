/**
 * Team Service Workflow Module
 * Implements high-level workflows that orchestrate multiple team service operations.
 * Provides logging, error handling, and workflow context management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getWorkflowLogger } from '../../infrastructure/logger';
import { ServiceError, ServiceErrorCode, createServiceError } from '../../types/error.type';
import type { Teams } from '../../types/team.type';
import type { TeamService, WorkflowContext, WorkflowResult } from './types';

const logger = getWorkflowLogger();

/**
 * Creates workflow context for tracking and logging
 */
const createWorkflowContext = (workflowId: string): WorkflowContext => ({
  workflowId,
  startTime: new Date(),
});

/**
 * Creates team workflow operations.
 * Implements high-level workflows that combine multiple service operations.
 */
export const teamWorkflows = (teamService: TeamService) => {
  /**
   * Syncs teams from FPL API to local database.
   * Handles logging, error mapping, and workflow context.
   */
  const syncTeams = (): TE.TaskEither<ServiceError, WorkflowResult<Teams>> => {
    const context = createWorkflowContext('team-sync');

    logger.info({ workflow: context.workflowId }, 'Starting team sync workflow');

    return pipe(
      teamService.syncTeamsFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Team sync workflow failed: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((teams) => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            count: teams.length,
            durationMs: duration,
          },
          'Team sync workflow completed successfully',
        );

        return {
          context,
          result: teams,
          duration,
        };
      }),
    );
  };

  return {
    syncTeams,
  } as const;
};

export type TeamWorkflows = ReturnType<typeof teamWorkflows>;
