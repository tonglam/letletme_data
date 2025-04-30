import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getWorkflowLogger } from 'infrastructure/logger';
import { PhaseService, PhaseWorkflowOperations } from 'service/phase/types';
import { createWorkflowContext, WorkflowResult } from 'service/types';
import { createServiceError, ServiceError, ServiceErrorCode } from 'types/error.type';

const logger = getWorkflowLogger();

export const createPhaseWorkflows = (phaseService: PhaseService): PhaseWorkflowOperations => {
  const syncPhases = (): TE.TaskEither<ServiceError, WorkflowResult> => {
    const context = createWorkflowContext('phase-sync');

    logger.info({ workflow: context.workflowId }, 'Starting phase sync workflow');

    return pipe(
      phaseService.syncPhasesFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Phase sync workflow failed: ${error.message}`,
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
          'Phase sync workflow completed successfully',
        );

        return {
          context,
          duration,
        };
      }),
    );
  };

  return {
    syncPhases,
  };
};
