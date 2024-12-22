import * as O from 'fp-ts/Option';
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
      TE.mapLeft((error) => ({
        ...error,
        message: `Phase sync failed: ${error.message}`,
      })),
      // Step 2: Verify phases are in database
      TE.chain((phasesFromAPI) =>
        pipe(
          phaseService.getPhases(),
          TE.map((phasesInDB) => ({ phasesFromAPI, phasesInDB })),
        ),
      ),
      // Step 3: Verify data integrity
      TE.chain(({ phasesFromAPI, phasesInDB }) => {
        const sortedAPI = [...phasesFromAPI].sort((a, b) => a.id - b.id);
        const sortedDB = [...phasesInDB].sort((a, b) => a.id - b.id);
        
        if (sortedDB.length !== sortedAPI.length) {
          return TE.left({
            code: 'VALIDATION_ERROR',
            message: 'Data integrity check failed: phase count mismatch',
          } as APIError);
        }

        for (let i = 0; i < sortedAPI.length; i++) {
          if (sortedAPI[i].id !== sortedDB[i].id || 
              sortedAPI[i].startEvent !== sortedDB[i].startEvent ||
              sortedAPI[i].stopEvent !== sortedDB[i].stopEvent) {
            return TE.left({
              code: 'VALIDATION_ERROR',
              message: 'Data integrity check failed: phase data mismatch',
            } as APIError);
          }
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
      // Validate inputs
      TE.fromPredicate(
        () => currentEventId > 0,
        () =>
          ({
            code: 'VALIDATION_ERROR',
            message: 'Invalid event ID provided',
          }) as APIError,
      )(currentEventId),
      // Step 1: Get specific phase
      TE.chain(() => phaseService.getPhase(phaseId)),
      TE.chainW((phase) =>
        pipe(
          O.fromNullable(phase),
          O.fold(
            () =>
              TE.left({
                code: 'NOT_FOUND',
                message: `Phase ${phaseId} not found`,
              } as APIError),
            (phase) => {
              // For explicit phase boundaries validation
              if (currentEventId < phase.startEvent || currentEventId > phase.stopEvent) {
                return TE.left({
                  code: 'VALIDATION_ERROR',
                  message: 'Event ID outside phase boundaries',
                } as APIError);
              }
              return pipe(
                phaseService.getCurrentActivePhase(currentEventId),
                TE.map((activePhase) => ({
                  phase,
                  isActive: activePhase?.id === phase.id,
                })),
              );
            },
          ),
        ),
      ),
    );

  return {
    syncAndVerifyPhases,
    getPhaseDetails,
  } as const;
};

export type PhaseWorkflows = ReturnType<typeof phaseWorkflows>;
