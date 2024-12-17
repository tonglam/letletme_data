import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError } from '../../infrastructure/api/common/errors';
import { Phase, PhaseId } from '../../types/phase.type';
import { PhaseService } from './index';

/**
 * Phase Service Workflows
 * Provides high-level operations combining multiple phase service operations
 */
export const phaseWorkflows = (phaseService: PhaseService) => {
  /**
   * Syncs phases from API and verifies data integrity
   * @returns TaskEither with synced phases or error
   */
  const syncAndVerifyPhases = (): TE.TaskEither<APIError, readonly Phase[]> =>
    pipe(
      // Step 1: Sync phases from API to database
      phaseService.syncPhases(),
      // Step 2: Verify phases are in database
      TE.chain((phasesFromAPI) =>
        pipe(
          phaseService.getPhases(),
          TE.map((phasesInDB) => ({ phasesFromAPI, phasesInDB })),
        ),
      ),
      // Step 3: Verify data integrity
      TE.chain(({ phasesFromAPI, phasesInDB }) => {
        if (phasesInDB.length !== phasesFromAPI.length) {
          return TE.left({
            code: 'VALIDATION_ERROR',
            message: 'Data integrity check failed: phase count mismatch',
          } as APIError);
        }
        return TE.right(phasesFromAPI);
      }),
    );

  /**
   * Gets phase details including current active status
   * @param phaseId - ID of the phase to get
   * @param currentEventId - Current event ID to check active status
   * @returns TaskEither with phase details or error
   */
  const getPhaseDetails = (
    phaseId: PhaseId,
    currentEventId: number,
  ): TE.TaskEither<APIError, { phase: Phase; isActive: boolean }> =>
    pipe(
      // Step 1: Get specific phase
      phaseService.getPhase(phaseId),
      // Step 2: Get current active phase
      TE.chain((phase) =>
        pipe(
          phaseService.getCurrentActivePhase(currentEventId),
          TE.map((activePhase) => ({
            phase: phase!,
            isActive: activePhase?.id === phase?.id,
          })),
        ),
      ),
    );

  return {
    syncAndVerifyPhases,
    getPhaseDetails,
  } as const;
};

export type PhaseWorkflows = ReturnType<typeof phaseWorkflows>;
