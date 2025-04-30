import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import {
  EventOverallResultService,
  EventOverallResultWorkflowOperations,
} from 'service/event-overall-result/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { EventId } from 'types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

import { EventService } from '../event/types';

const logger = getWorkflowLogger();

export const createEventOverallResultWorkflows = (
  eventService: EventService,
  eventOverallResultService: EventOverallResultService,
): EventOverallResultWorkflowOperations => {
  const syncEventOverallResults = (
    eventId: EventId,
  ): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext(`event-overall-result-sync-${eventId}`);
    const startTime = new Date().getTime();

    logger.info(
      { workflow: context.workflowId, eventId },
      'Starting event overall result sync workflow',
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
            'Skipping event overall result sync: Not a match day or not after match day.',
          );
          return createServiceError({
            code: ServiceErrorCode.CONDITION_NOT_MET,
            message: 'Skipped: Conditions not met',
          });
        },
      ),
      TE.chainW(() => eventOverallResultService.syncEventOverallResultsFromApi(eventId)),
      TE.map(() => {
        const duration = new Date().getTime() - startTime;
        logger.info(
          {
            workflow: context.workflowId,
            eventId,
            duration,
          },
          'Event overall result sync workflow completed successfully',
        );
        return { context, duration };
      }),
      TE.orElseW((error) => {
        if (error.code === ServiceErrorCode.CONDITION_NOT_MET) {
          return TE.right({ context, duration: new Date().getTime() - startTime });
        }
        logger.error(
          { workflow: context.workflowId, eventId, err: error },
          `Event overall result sync workflow for event ${eventId} failed: ${error.message}`,
        );
        return TE.left(
          createServiceError({
            code: ServiceErrorCode.INTEGRATION_ERROR,
            message: `Event overall result sync workflow failed: ${error.message}`,
            cause: error,
          }),
        );
      }),
    );
  };

  return {
    syncEventOverallResults,
  };
};
