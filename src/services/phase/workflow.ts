import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { getWorkflowLogger } from '../../infrastructures/logger';
import type { Phase } from '../../types/domain/phase.type';
import { createServiceError, ServiceError, ServiceErrorCode } from '../../types/error.type';
import type { WorkflowResult } from '../types';
import { createWorkflowContext } from '../types';
import type { PhaseService } from './types';

const logger = getWorkflowLogger();

export const phaseWorkflows = (phaseService: PhaseService) => {
  const syncPhases = (): TE.TaskEither<ServiceError, WorkflowResult<readonly Phase[]>> => {
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
      TE.map((phases) => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            count: phases.length,
            durationMs: duration,
          },
          'Phase sync workflow completed successfully',
        );

        return {
          context,
          result: phases,
          duration,
        };
      }),
    );
  };

  return {
    syncPhases,
  } as const;
};

export type PhaseWorkflows = ReturnType<typeof phaseWorkflows>;
