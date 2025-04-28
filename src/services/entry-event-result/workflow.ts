import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EventId } from 'src/types/domain/event.type';

import { getWorkflowLogger } from '../../infrastructures/logger';
import { createServiceError, ServiceError, ServiceErrorCode } from '../../types/error.type';
import { createWorkflowContext } from '../types';

import type { WorkflowResult } from '../types';
import type { EntryEventResultService, EntryEventResultWorkflowOperations } from './types';

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
