import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructures/logger';
import {
  EventOverallResultService,
  EventOverallResultWorkflowOperations,
} from 'services/event-overall-result/types';
import { createWorkflowContext, WorkflowResult } from 'services/types';
import { EventId } from 'types/domain/event.type';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

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
