// Phase Handlers Module
//
// Provides handlers for phase-related API endpoints using functional programming
// patterns with fp-ts. Handles phase retrieval operations including getting all phases
// and specific phases by ID.

import { Request } from 'express';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { toAPIError } from 'src/utils/error.util';
import { ServiceContainer, ServiceKey } from '../../service';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { Phase, PhaseId } from '../../types/phase.type';
import { PhaseHandlerResponse } from '../types';

// Creates phase handlers with dependency injection
export const createPhaseHandlers = (
  phaseService: ServiceContainer[typeof ServiceKey.PHASE],
): PhaseHandlerResponse => ({
  // Retrieves all phases
  getAllPhases: () => {
    const task = phaseService.getPhases() as unknown as TE.TaskEither<ServiceError, Phase[]>;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((phases) => phases.slice()),
    );
  },

  // Retrieves a specific phase by ID
  getPhaseById: (req: Request) => {
    const phaseId = Number(req.params.id);
    if (isNaN(phaseId) || phaseId <= 0) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid phase ID: must be a positive integer',
        }),
      );
    }

    const task = phaseService.getPhase(phaseId as PhaseId) as unknown as TE.TaskEither<
      ServiceError,
      Phase | null
    >;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.chain((phase) =>
        phase === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: `Phase with ID ${phaseId} not found`,
              }),
            )
          : TE.right(phase),
      ),
    );
  },
});
