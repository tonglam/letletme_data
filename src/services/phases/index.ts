import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getAllPhases, getCurrentPhase, getPhaseById } from '../../domains/phases/queries';
import { phaseRepository } from '../../domains/phases/repository';
import type { APIError } from '../../infrastructure/api/common/errors';
import { createValidationError } from '../../infrastructure/api/common/errors';
import type { Phase, PhaseId } from '../../types/phase.type';

/**
 * Phase service factory
 * Creates a service instance with required dependencies
 */
export const createPhaseService = (bootstrapApi: {
  readonly getBootstrapData: () => Promise<Phase[] | null>;
}) => {
  /**
   * Sync phases from FPL API
   * @returns TaskEither with array of synced phases or error
   */
  const syncPhases = (): TE.TaskEither<APIError, readonly Phase[]> =>
    pipe(
      TE.tryCatch(
        () => bootstrapApi.getBootstrapData(),
        (error) =>
          createValidationError({
            message: `Failed to fetch bootstrap data: ${String(error)}`,
          }),
      ),
      TE.chain((phases) =>
        phases
          ? pipe(
              phases,
              TE.traverseArray((phase) =>
                phaseRepository.save({
                  id: phase.id,
                  name: phase.name,
                  startEvent: phase.startEvent,
                  stopEvent: phase.stopEvent,
                  highestScore: phase.highestScore,
                }),
              ),
            )
          : TE.left(createValidationError({ message: 'No phases data available from API' })),
      ),
    );

  /**
   * Get all phases
   * @returns TaskEither with array of phases or error
   */
  const getPhases = (): TE.TaskEither<APIError, readonly Phase[]> => getAllPhases(phaseRepository);

  /**
   * Get phase by ID
   * @param id - Phase ID to find
   * @returns TaskEither with phase or error
   */
  const getPhase = (id: PhaseId): TE.TaskEither<APIError, Phase | null> =>
    getPhaseById(phaseRepository, id);

  /**
   * Get current active phase
   * @param currentEventId - Current event ID
   * @returns TaskEither with current phase or error
   */
  const getCurrentActivePhase = (currentEventId: number): TE.TaskEither<APIError, Phase | null> =>
    getCurrentPhase(phaseRepository, currentEventId);

  return {
    syncPhases,
    getPhases,
    getPhase,
    getCurrentActivePhase,
  } as const;
};

/**
 * Phase service type
 */
export type PhaseService = ReturnType<typeof createPhaseService>;
