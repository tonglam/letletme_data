import { Request } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { ServiceContainer } from '../../services/types';
import { Phase, PhaseId } from '../../types/domain/phase.type';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';
import { PhaseHandlerResponse } from '../types';

export const createPhaseHandlers = (
  phaseService: ServiceContainer['phaseService'],
): PhaseHandlerResponse => ({
  getAllPhases: () => {
    const task = phaseService.getPhases() as TE.TaskEither<ServiceError, Phase[]>;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((phases) => [...phases]),
    );
  },

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

    return pipe(
      phaseService.getPhase(phaseId as PhaseId) as TE.TaskEither<ServiceError, Phase | null>,
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
