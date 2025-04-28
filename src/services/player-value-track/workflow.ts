import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructures/logger';
import {
  PlayerValueTrackService,
  PlayerValueTrackWorkflowsOperations,
} from 'services/player-value-track/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const playerValueTrackWorkflows = (
  playerValueTrackService: PlayerValueTrackService,
): PlayerValueTrackWorkflowsOperations => {
  const syncPlayerValueTracks = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('player-value-sync');

    logger.info({ workflow: context.workflowId }, 'Starting player value sync workflow');

    return pipe(
      playerValueTrackService.syncPlayerValueTracksFromApi(),

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
    syncPlayerValueTracks,
  };
};
