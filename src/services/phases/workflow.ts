import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError, createValidationError } from '../../infrastructure/api/common/errors';
import { Phase, PhaseId } from '../../types/phase.type';
import { PhaseService } from './index';

/**
 * Phase Service Workflows
 * Provides high-level operations combining multiple phase service operations
 */
export const phaseWorkflows = (phaseService: PhaseService) => {
  /**
   * Syncs phases from API to local database
   * Existing data will be truncated and replaced with new data
   *
   * @returns TaskEither<APIError, readonly Phase[]> - Success: synced phases, Error: APIError
   */
  const syncAndVerifyPhases = (): TE.TaskEither<APIError, readonly Phase[]> =>
    pipe(
      phaseService.syncPhases(),
      TE.mapLeft((error) => ({
        ...error,
        message: `Phase sync failed: ${error.message}`,
      })),
    );

  /**
   * Retrieves detailed phase information and determines if it's currently active
   *
   * Validation checks:
   * 1. Validates currentEventId is positive
   * 2. Confirms phase exists
   * 3. Verifies event is within phase boundaries
   *
   * The phase is considered active if:
   * - The event ID falls within phase boundaries (startEvent ≤ eventId ≤ stopEvent)
   * - It matches the currently active phase for the given event
   *
   * @param phaseId - Unique identifier of the phase
   * @param currentEventId - Current event ID to check against phase boundaries
   * @returns TaskEither with object containing:
   *         - phase: The requested Phase object
   *         - isActive: Boolean indicating if phase is currently active
   */
  const getPhaseDetails = (
    phaseId: PhaseId,
    currentEventId: number,
  ): TE.TaskEither<APIError, { phase: Phase; isActive: boolean }> =>
    pipe(
      TE.fromPredicate(
        () => currentEventId > 0,
        () =>
          createValidationError({
            message: 'Invalid event ID provided',
          }),
      )(currentEventId),
      TE.chain(() => phaseService.getPhase(phaseId)),
      TE.chain((phase) =>
        phase === null
          ? TE.left(createValidationError({ message: `Phase ${phaseId} not found` }))
          : pipe(
              phaseService.getCurrentActivePhase(currentEventId),
              TE.map((activePhase) => ({
                phase,
                isActive: activePhase?.id === phase.id,
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
