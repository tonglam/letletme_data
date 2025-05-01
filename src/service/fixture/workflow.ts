import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { FixtureWorkflowsOperations } from 'service/fixture/types';
import { FixtureService } from 'service/fixture/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const createFixtureWorkflows = (
  fixtureService: FixtureService,
): FixtureWorkflowsOperations => {
  const syncFixtures = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('events-fixture-sync');

    logger.info({ workflow: context.workflowId }, 'Starting fixture sync workflow');

    return pipe(
      fixtureService.syncFixturesFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Fixture sync workflow failed: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map(() => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          { workflow: context.workflowId, durationMs: duration },
          'Fixture sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncFixtures,
  };
};
