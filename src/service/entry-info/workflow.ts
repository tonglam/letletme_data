import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { EntryInfoService, EntryInfoWorkflowOperations } from 'service/entry-info/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const entryInfoWorkflows = (
  entryInfoService: EntryInfoService,
): EntryInfoWorkflowOperations => {
  const syncEntryInfos = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('entry-info-sync');

    logger.info({ workflow: context.workflowId }, 'Starting entry info sync workflow');

    return pipe(
      entryInfoService.syncEntryInfosFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Entry info sync workflow failed: ${error.message}`,
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
          'Entry info sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEntryInfos,
  };
};
