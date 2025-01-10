/**
 * Player Value Service Workflow Module
 * Implements high-level workflows that orchestrate multiple player value service operations.
 * Provides logging, error handling, and workflow context management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getWorkflowLogger } from '../../infrastructure/logger';
import { ServiceError, ServiceErrorCode, createServiceError } from '../../types/error.type';
import type { PlayerValues } from '../../types/player-value.type';
import type { PlayerValueService, WorkflowContext, WorkflowResult } from './types';

const logger = getWorkflowLogger();

/**
 * Creates workflow context for tracking and logging
 */
const createWorkflowContext = (workflowId: string): WorkflowContext => ({
  workflowId,
  startTime: new Date(),
});

/**
 * Creates player value workflow operations.
 * Implements high-level workflows that combine multiple service operations.
 */
export const playerValueWorkflows = (playerValueService: PlayerValueService) => {
  /**
   * Syncs player values from FPL API to local database.
   * Handles logging, error mapping, and workflow context.
   */
  const syncPlayerValues = (): TE.TaskEither<ServiceError, WorkflowResult<PlayerValues>> => {
    const context = createWorkflowContext('player-value-sync');

    logger.info({ workflow: context.workflowId }, 'Starting player value sync workflow');

    return pipe(
      playerValueService.syncPlayerValuesFromApi(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: `Player value sync workflow failed: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((values) => {
        const duration = new Date().getTime() - context.startTime.getTime();

        logger.info(
          {
            workflow: context.workflowId,
            count: values.length,
            durationMs: duration,
          },
          'Player value sync workflow completed successfully',
        );

        return {
          context,
          result: values,
          duration,
        };
      }),
    );
  };

  return {
    syncPlayerValues,
  } as const;
};

export type PlayerValueWorkflows = ReturnType<typeof playerValueWorkflows>;
