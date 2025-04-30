import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { EventLiveService } from 'service/event-live/types';
import { EventLiveWorkflowsOperations } from 'service/event-live/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { EventId } from 'types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

import { EventService } from '../event/types';

const logger = getWorkflowLogger();

export const createEventLiveWorkflows = (
  eventService: EventService,
  eventLiveService: EventLiveService,
): EventLiveWorkflowsOperations => {
  const syncEventLiveCache = (eventId: EventId): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext(`event-live-sync-${eventId}`);
    const startTime = new Date().getTime();

    logger.info(
      { workflow: context.workflowId, eventId },
      'Starting event live cache sync workflow',
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
            'Skipping event live cache sync: Not a match day or not after match day.',
          );
          return createServiceError({
            code: ServiceErrorCode.CONDITION_NOT_MET,
            message: 'Skipped: Conditions not met',
          });
        },
      ),
      TE.chainW(() => eventLiveService.syncEventLiveCacheFromApi(eventId)),
      TE.map(() => {
        const duration = new Date().getTime() - startTime;
        logger.info(
          {
            workflow: context.workflowId,
            eventId,
            duration,
          },
          'Event live cache sync workflow completed',
        );
        return { context, duration };
      }),
      TE.orElseW((error) => {
        if (error.code === ServiceErrorCode.CONDITION_NOT_MET) {
          return TE.right({ context, duration: new Date().getTime() - startTime });
        }
        logger.error(
          { workflow: context.workflowId, eventId, err: error },
          `Event live cache sync workflow for event ${eventId} failed: ${error.message}`,
        );
        return TE.left(
          createServiceError({
            code: ServiceErrorCode.INTEGRATION_ERROR,
            message: `Event live cache sync workflow for event ${eventId} failed: ${error.message}`,
            cause: error,
          }),
        );
      }),
    );
  };

  const syncEventLives = (eventId: EventId): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext(`event-live-sync-${eventId}`);
    const startTime = new Date().getTime();

    logger.info({ workflow: context.workflowId, eventId }, 'Starting event live sync workflow');

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
            'Skipping event live sync: Not a match day or not after match day.',
          );
          return createServiceError({
            code: ServiceErrorCode.CONDITION_NOT_MET,
            message: 'Skipped: Conditions not met',
          });
        },
      ),
      TE.chainW(() => eventLiveService.syncEventLivesFromApi(eventId)),
      TE.map(() => {
        const duration = new Date().getTime() - startTime;
        logger.info(
          {
            workflow: context.workflowId,
            eventId,
            duration,
          },
          'Event live sync workflow completed',
        );
        return { context, duration };
      }),
      TE.orElseW((error) => {
        if (error.code === ServiceErrorCode.CONDITION_NOT_MET) {
          return TE.right({ context, duration: new Date().getTime() - startTime });
        }
        logger.error(
          { workflow: context.workflowId, eventId, err: error },
          `Event live sync workflow for event ${eventId} failed: ${error.message}`,
        );
        return TE.left(
          createServiceError({
            code: ServiceErrorCode.INTEGRATION_ERROR,
            message: `Event live sync workflow for event ${eventId} failed: ${error.message}`,
            cause: error,
          }),
        );
      }),
    );
  };

  return {
    syncEventLiveCache,
    syncEventLives,
  };
};
