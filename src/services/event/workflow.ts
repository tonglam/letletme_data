import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructures/logger';
import { EventService, EventWorkflowOperations } from 'services/event/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const eventWorkflows = (eventService: EventService): EventWorkflowOperations => {
  const syncEvents = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('event-sync');

    logger.info({ workflow: context.workflowId }, 'Starting event sync workflow');

    return pipe(
      eventService.syncEventsFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Event sync workflow failed during sync or subsequent fetch: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map(() => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            durationMs: duration,
          },
          'Event sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEvents,
  };
};
