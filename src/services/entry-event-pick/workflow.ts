import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { getWorkflowLogger } from '../../infrastructures/logger';
import { createServiceError, ServiceError, ServiceErrorCode } from '../../types/error.type';
import { createWorkflowContext } from '../types';

import type { WorkflowResult } from '../types';
import type { EntryEventPickService, EntryEventPickWorkflowOperations } from './types';

const logger = getWorkflowLogger();

export const entryEventPickWorkflows = (
  entryEventPickService: EntryEventPickService,
): EntryEventPickWorkflowOperations => {
  const syncEntryEventPicks = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('entry-event-pick-sync');

    logger.info({ workflow: context.workflowId }, 'Starting entry event pick sync workflow');

    return pipe(
      entryEventPickService.syncEntryEventPicksFromApi(),
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
