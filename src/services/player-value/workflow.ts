import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValueService, PlayerValueWorkflowsOperations } from 'services/player-value/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';
import { getWorkflowLogger } from 'src/infrastructures/logger';
import { createServiceError, ServiceError, ServiceErrorCode } from 'src/types/error.type';

const logger = getWorkflowLogger();

export const playerValueWorkflows = (
  playerValueService: PlayerValueService,
): PlayerValueWorkflowsOperations => {
  const syncPlayerValues = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('player-value-sync');

    logger.info({ workflow: context.workflowId }, 'Starting player value sync workflow');

    return pipe(
      playerValueService.syncPlayerValuesFromApi(),

      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Player value sync workflow failed: ${error.message}`,
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
    syncPlayerValues,
  };
};
