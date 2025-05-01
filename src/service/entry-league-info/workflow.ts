import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { EntryInfoService } from 'service/entry-info/types';
import {
  EntryLeagueInfoService,
  EntryLeagueInfoWorkflowOperations,
} from 'service/entry-league-info/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const createEntryLeagueInfoWorkflows = (
  entryLeagueInfoService: EntryLeagueInfoService,
  entryInfoService: EntryInfoService,
): EntryLeagueInfoWorkflowOperations => {
  const syncEntryLeagueInfos = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('entry-league-info-sync');

    logger.info({ workflow: context.workflowId }, 'Starting entry league info sync workflow');

    return pipe(
      entryInfoService.getAllEntryIds(),
      TE.chainW((ids) => entryLeagueInfoService.syncLeaguesInfosFromApi(ids)),
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
    syncLeagueInfos: syncEntryLeagueInfos,
  };
};
