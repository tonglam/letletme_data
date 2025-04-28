import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructures/logger';
import { EventLiveExplainService } from 'services/event-live-explain/types';
import { EventLiveExplainWorkflowsOperations } from 'services/event-live-explain/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';
import { EventId } from 'types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const eventLiveExplainWorkflows = (
  eventLiveExplainService: EventLiveExplainService,
): EventLiveExplainWorkflowsOperations => {
  const syncEventLiveExplains = (eventId: EventId): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext(`event-live-explain-sync-${eventId}`);

    logger.info(
      { workflow: context.workflowId, eventId },
      'Starting event live explain sync workflow',
    );

    return pipe(
      eventLiveExplainService.syncEventLiveExplainsFromApi(eventId),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Event live explain sync workflow for event ${eventId} failed: ${error.message}`,
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
          'Event live explain sync workflow completed',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEventLiveExplains,
  };
};
