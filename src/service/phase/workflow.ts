/**
 * Phase Service Workflow Module
 * Implements high-level workflows that orchestrate multiple phase service operations.
 * Provides logging, error handling, and workflow context management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getWorkflowLogger } from '../../infrastructure/logger';
import { ServiceError, ServiceErrorCode, createServiceError } from '../../types/error.type';
import type { Phases } from '../../types/phase.type';
import type { PhaseService, WorkflowContext, WorkflowResult } from './types';

const logger = getWorkflowLogger();

/**
 * Creates workflow context for tracking and logging
 */
const createWorkflowContext = (workflowId: string): WorkflowContext => ({
  workflowId,
  startTime: new Date(),
});

/**
 * Creates phase workflow operations.
 * Implements high-level workflows that combine multiple service operations.
 */
export const phaseWorkflows = (phaseService: PhaseService) => {
  /**
   * Syncs phases from FPL API to local database.
   * Handles logging, error mapping, and workflow context.
   */
  const syncPhases = (): TE.TaskEither<ServiceError, WorkflowResult<Phases>> => {
    const context = createWorkflowContext('phase-sync');

    logger.info({ workflow: context.workflowId }, 'Starting phase sync workflow');

    return pipe(
      phaseService.syncPhasesFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Phase sync workflow failed: ${error.message}`,
          cause: error,
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
