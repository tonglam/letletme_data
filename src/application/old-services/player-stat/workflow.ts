import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { PlayerStatService, PlayerStatWorkflowsOperations } from 'service/player-stat/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const createPlayerStatWorkflows = (
  playerStatService: PlayerStatService,
): PlayerStatWorkflowsOperations => {
  const syncPlayerStats = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('player-stat-sync');

    logger.info({ workflow: context.workflowId }, 'Starting player stat sync workflow');

    return pipe(
      playerStatService.syncPlayerStatsFromApi(),
      TE.chainW(() => playerStatService.getPlayerStats()),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
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
