import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { getWorkflowLogger } from '../../infrastructures/logger';
import type { Event } from '../../types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from '../../types/error.type';
import type { WorkflowResult } from '../types';
import { createWorkflowContext } from '../types';
import type { EventService } from './types';

const logger = getWorkflowLogger();

export const eventWorkflows = (eventService: EventService) => {
  const syncEvents = (): TE.TaskEither<ServiceError, WorkflowResult<readonly Event[]>> => {
    const context = createWorkflowContext('event-sync');

    logger.info({ workflow: context.workflowId }, 'Starting event sync workflow');

    return pipe(
      eventService.syncEventsFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Event sync workflow failed: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((events) => {
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
  } as const;
};

export type EventWorkflows = ReturnType<typeof eventWorkflows>;
