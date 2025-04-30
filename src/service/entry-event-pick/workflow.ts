import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import {
  EntryEventPickService,
  EntryEventPickWorkflowOperations,
} from 'service/entry-event-pick/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { EventId } from 'types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const createEntryEventPickWorkflows = (
  entryEventPickService: EntryEventPickService,
): EntryEventPickWorkflowOperations => {
  const syncEntryEventPicks = (eventId: EventId): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('entry-event-pick-sync');

    logger.info({ workflow: context.workflowId }, 'Starting entry event pick sync workflow');

    return pipe(
      entryEventPickService.syncPicksFromApi(eventId),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Entry event pick sync workflow failed: ${error.message}`,
          cause: error instanceof Error ? error : undefined,
        }),
      ),
      TE.map(() => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            durationMs: duration,
          },
          'Entry event pick sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEntryEventPicks,
  };
};
