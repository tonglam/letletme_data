/**
 * Event Service Workflow Module
 * Implements high-level workflows that orchestrate multiple event service operations.
 * Provides logging, error handling, and workflow context management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getWorkflowLogger } from '../../infrastructure/logger';
import { ServiceError } from '../../types/errors.type';
import type { Event } from '../../types/events.type';
import { createServiceOperationError } from '../../utils/error.util';
import type { EventService, WorkflowContext, WorkflowResult } from './types';

const logger = getWorkflowLogger();

/**
 * Creates workflow context for tracking and logging
 */
const createWorkflowContext = (workflowId: string): WorkflowContext => ({
  workflowId,
  startTime: new Date(),
});

/**
 * Creates event workflow operations.
 * Implements high-level workflows that combine multiple service operations.
 */
export const eventWorkflows = (eventService: EventService) => {
  /**
   * Syncs events from FPL API to local database.
   * Handles logging, error mapping, and workflow context.
   */
  const syncEvents = (): TE.TaskEither<ServiceError, WorkflowResult<readonly Event[]>> => {
    const context = createWorkflowContext('event-sync');

    logger.info({ workflow: context.workflowId }, 'Starting event sync workflow');

    return pipe(
      eventService.syncEventsFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceOperationError({
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
