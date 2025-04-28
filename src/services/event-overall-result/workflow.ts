import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EventId } from 'src/types/domain/event.type';

import { getWorkflowLogger } from '../../infrastructures/logger';
import { createServiceError, ServiceError, ServiceErrorCode } from '../../types/error.type';
import { createWorkflowContext } from '../types';

import type { WorkflowResult } from '../types';
import type { EventOverallResultService, EventOverallResultWorkflowOperations } from './types';

const logger = getWorkflowLogger();

export const eventOverallResultWorkflows = (
  eventOverallResultService: EventOverallResultService,
): EventOverallResultWorkflowOperations => {
  const syncEventOverallResults = (
    eventId: EventId,
  ): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('event-overall-result-sync');

    logger.info({ workflow: context.workflowId }, 'Starting event overall result sync workflow');

    return pipe(
      eventOverallResultService.syncEventOverallResultsFromApi(eventId),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Event overall result sync workflow failed: ${error.message}`,
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
          'Event overall result sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncEventOverallResults,
  };
};
