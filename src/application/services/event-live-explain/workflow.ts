import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { EventService } from 'service/event/types';
import { EventLiveExplainService } from 'service/event-live-explain/types';
import { EventLiveExplainWorkflowsOperations } from 'service/event-live-explain/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { EventId } from 'types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const createEventLiveExplainWorkflows = (
  eventService: EventService,
  eventLiveExplainService: EventLiveExplainService,
): EventLiveExplainWorkflowsOperations => {
  const syncEventLiveExplains = (eventId: EventId): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext(`event-live-explain-sync-${eventId}`);
    const startTime = new Date().getTime();

    logger.info(
      { workflow: context.workflowId, eventId },
      'Starting event live explain sync workflow',
    );

    return pipe(
      TE.Do,
      TE.bind('isMatchDay', () => eventService.isMatchDay(eventId)),
      TE.bind('isAfterMatchDay', () => eventService.isAfterMatchDay(eventId)),
      TE.filterOrElse(
        ({ isMatchDay, isAfterMatchDay }) => isMatchDay && isAfterMatchDay,
        () => {
          logger.info(
            {
              workflow: context.workflowId,
              eventId,
            },
            'Skipping event live explain sync: Not a match day or not after match day.',
          );
          return createServiceError({
            code: ServiceErrorCode.CONDITION_NOT_MET,
            message: 'Skipped: Conditions not met',
          });
        },
      ),
      TE.chainW(() => eventLiveExplainService.syncEventLiveExplainsFromApi(eventId)),
      TE.map(() => {
        const duration = new Date().getTime() - startTime;
        logger.info(
          {
            workflow: context.workflowId,
            eventId,
            duration,
          },
          'Event live explain sync workflow completed',
        );
        return { context, duration };
      }),
      TE.orElseW((error) => {
        if (error.code === ServiceErrorCode.CONDITION_NOT_MET) {
          return TE.right({ context, duration: new Date().getTime() - startTime });
        }
        logger.error(
          { workflow: context.workflowId, eventId, err: error },
          `Event live explain sync workflow for event ${eventId} failed: ${error.message}`,
        );
        return TE.left(
          createServiceError({
            code: ServiceErrorCode.INTEGRATION_ERROR,
            message: `Event live explain sync workflow for event ${eventId} failed: ${error.message}`,
            cause: error,
          }),
        );
      }),
    );
  };

  return {
    syncEventLiveExplains,
  };
};
