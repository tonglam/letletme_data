import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import {
  PlayerValueTrackService,
  PlayerValueTrackWorkflowsOperations,
} from 'service/player-value-track/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const createPlayerValueTrackWorkflows = (
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
