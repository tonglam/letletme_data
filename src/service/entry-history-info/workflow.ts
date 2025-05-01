import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import {
  EntryHistoryInfoService,
  EntryHistoryInfoWorkflowOperations,
} from 'service/entry-history-info/types';
import { EntryInfoService } from 'service/entry-info/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const createEntryHistoryInfoWorkflows = (
  entryHistoryInfoService: EntryHistoryInfoService,
  entryInfoService: EntryInfoService,
): EntryHistoryInfoWorkflowOperations => {
  const syncEntryHistoryInfos = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('entry-history-info-sync');

    logger.info({ workflow: context.workflowId }, 'Starting entry history info sync workflow');

    return pipe(
      TE.Do,
      TE.bind('allIds', () => entryInfoService.getAllEntryIds()),
      TE.bind('syncedIds', () => entryHistoryInfoService.getAllEntryIds()),
      TE.chainW(({ allIds, syncedIds }) => {
        const syncedIdSet = new Set(syncedIds);
        const idsToSync = allIds.filter((id) => !syncedIdSet.has(id));

        if (idsToSync.length === 0) {
          logger.info({ workflow: context.workflowId }, 'No new entry history infos to sync.');
          return TE.right(undefined);
        }

        logger.info(
          { workflow: context.workflowId, count: idsToSync.length },
          'Syncing new entry history infos...',
        );
        return entryHistoryInfoService.syncHistoryInfosFromApi(idsToSync);
      }),
      TE.mapLeft((error: ServiceError) => {
        logger.error(
          { workflow: context.workflowId, error },
          'Entry history info sync workflow failed',
        );
        return createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Entry history info sync workflow failed: ${error.message}`,
          cause: error instanceof Error ? error : undefined,
        });
      }),
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
    syncHistoryInfos: syncEntryHistoryInfos,
  };
};
