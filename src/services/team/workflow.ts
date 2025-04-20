import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { TeamService, TeamWorkflowsOperations } from 'services/team/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';

import { getWorkflowLogger } from '../../infrastructures/logger';
import { createServiceError, ServiceError, ServiceErrorCode } from '../../types/error.type';

import type { Teams } from '../../types/domain/team.type';

const logger = getWorkflowLogger();

export const teamWorkflows = (teamService: TeamService): TeamWorkflowsOperations => {
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
  };
};
