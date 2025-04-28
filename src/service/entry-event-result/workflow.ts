import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import {
  EntryEventResultService,
  EntryEventResultWorkflowOperations,
} from 'service/entry-event-result/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { EventId } from 'types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const entryEventResultWorkflows = (
  entryEventResultService: EntryEventResultService,
): EntryEventResultWorkflowOperations => {
  const syncEntryEventResults = (eventId: EventId): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('entry-event-result-sync');

    logger.info({ workflow: context.workflowId }, 'Starting entry event result sync workflow');

    return pipe(
      entryEventResultService.syncResultsFromApi(eventId),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Entry event result sync workflow failed: ${error.message}`,
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
          'Entry event result sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEntryEventResults,
  };
};
