import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { getWorkflowLogger } from '../../infrastructures/logger';
import { createServiceError, ServiceError, ServiceErrorCode } from '../../types/error.type';
import { createWorkflowContext } from '../types';

import type { Events } from '../../types/domain/event.type';
import type { WorkflowResult } from '../types';
import type { EventService, EventWorkflowOperations } from './types';

const logger = getWorkflowLogger();

export const eventWorkflows = (eventService: EventService): EventWorkflowOperations => {
  const syncEvents = (): TE.TaskEither<ServiceError, WorkflowResult<Events>> => {
    const context = createWorkflowContext('event-sync');

    logger.info({ workflow: context.workflowId }, 'Starting event sync workflow');

    return pipe(
      eventService.syncEventsFromApi(),
      TE.chainW(() => eventService.getEvents()),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Event sync workflow failed during sync or subsequent fetch: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((events: Events) => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            count: events.length,
            durationMs: duration,
          },
          'Event sync workflow completed successfully',
        );

        return {
          context,
          result: events,
          duration,
        };
      }),
    );
  };

  return {
    syncEvents,
  };
};
