import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatService } from 'services/player-stat/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';
import { getWorkflowLogger } from 'src/infrastructures/logger';
import { PlayerStat } from 'src/types/domain/player-stat.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'src/types/error.type';

const logger = getWorkflowLogger();

export const playerStatWorkflows = (playerStatService: PlayerStatService) => {
  const syncPlayerStats = (): TE.TaskEither<
    ServiceError,
    WorkflowResult<readonly PlayerStat[]>
  > => {
    const context = createWorkflowContext('player-stat-sync');

    logger.info({ workflow: context.workflowId }, 'Starting player stat sync workflow');

    return pipe(
      playerStatService.syncPlayerStatsFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to sync player stats',
          cause: error,
        }),
      ),
      TE.map((playerStats) => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info({
          workflow: context.workflowId,
          duration,
          playerStatsCount: playerStats.length,
        });

        return {
          context,
          result: playerStats,
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
