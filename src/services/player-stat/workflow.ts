import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatService, PlayerStatWorkflowsOperations } from 'services/player-stat/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';
import { getWorkflowLogger } from 'src/infrastructures/logger';
import { createServiceError, ServiceError, ServiceErrorCode } from 'src/types/error.type';

const logger = getWorkflowLogger();

export const playerStatWorkflows = (
  playerStatService: PlayerStatService,
): PlayerStatWorkflowsOperations => {
  const syncPlayerStats = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('player-stat-sync');

    logger.info({ workflow: context.workflowId }, 'Starting player stat sync workflow');

    return pipe(
      playerStatService.syncPlayerStatsFromApi(),
      TE.chainW(() => playerStatService.getLatestPlayerStats()),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to sync player stats',
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
    syncPlayerStats,
  };
};
