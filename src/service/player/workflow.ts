import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { PlayerService, PlayerWorkflowsOperations } from 'service/player/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const playerWorkflows = (playerService: PlayerService): PlayerWorkflowsOperations => {
  const syncPlayers = (): TE.TaskEither<ServiceError, WorkflowResult> => {
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
      TE.map(() => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info({
          workflow: context.workflowId,
          duration,
        });

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncPlayers,
  };
};
