import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructures/logger';
import { EventLiveService } from 'services/event-live/types';
import { EventLiveWorkflowsOperations } from 'services/event-live/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';
import { EventId } from 'types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const eventLiveWorkflows = (
  eventLiveService: EventLiveService,
): EventLiveWorkflowsOperations => {
  const syncEventLives = (eventId: EventId): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext(`event-live-sync-${eventId}`);

    logger.info({ workflow: context.workflowId, eventId }, 'Starting event live sync workflow');

    return pipe(
      eventLiveService.syncEventLivesFromApi(eventId),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Event live sync workflow for event ${eventId} failed: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map(() => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            eventId,
            duration,
          },
          'Event live sync workflow completed',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEventLives,
  };
};
