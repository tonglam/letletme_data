import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { getWorkflowLogger } from '../../infrastructures/logger';
import { createServiceError, ServiceError, ServiceErrorCode } from '../../types/error.type';
import { createWorkflowContext } from '../types';

import type { WorkflowResult } from '../types';
import type { EntryEventTransferService, EntryEventTransferWorkflowOperations } from './types';

const logger = getWorkflowLogger();

export const entryEventTransferWorkflows = (
  entryEventTransferService: EntryEventTransferService,
): EntryEventTransferWorkflowOperations => {
  const syncEntryEventTransfers = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('entry-event-transfer-sync');

    logger.info({ workflow: context.workflowId }, 'Starting entry event transfer sync workflow');

    return pipe(
      entryEventTransferService.syncEntryEventTransfersFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Entry event transfer sync workflow failed: ${error.message}`,
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
          'Entry event transfer sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEntryEventTransfers,
  };
};
