import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructures/logger';
import {
  EntryHistoryInfoService,
  EntryHistoryInfoWorkflowOperations,
} from 'services/entry-history-info/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const entryHistoryInfoWorkflows = (
  entryHistoryInfoService: EntryHistoryInfoService,
): EntryHistoryInfoWorkflowOperations => {
  const syncEntryHistoryInfos = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('entry-history-info-sync');

    logger.info({ workflow: context.workflowId }, 'Starting entry history info sync workflow');

    return pipe(
      entryHistoryInfoService.syncEntryHistoryInfosFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Entry history info sync workflow failed: ${error.message}`,
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
          'Entry history info sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEntryHistoryInfos,
  };
};
