import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { getWorkflowLogger } from '../../infrastructures/logger';
import { createServiceError, ServiceError, ServiceErrorCode } from '../../types/error.type';
import { createWorkflowContext } from '../types';

import type { WorkflowResult } from '../types';
import type { EntryLeagueInfoService, EntryLeagueInfoWorkflowOperations } from './types';

const logger = getWorkflowLogger();

export const entryLeagueInfoWorkflows = (
  entryLeagueInfoService: EntryLeagueInfoService,
): EntryLeagueInfoWorkflowOperations => {
  const syncEntryLeagueInfos = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('entry-league-info-sync');

    logger.info({ workflow: context.workflowId }, 'Starting entry league info sync workflow');

    return pipe(
      entryLeagueInfoService.syncEntryLeagueInfosFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Entry league info sync workflow failed: ${error.message}`,
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
          'Entry league info sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEntryLeagueInfos,
  };
};
