import { Request } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { ServiceContainer } from '../../services/types';
import { PlayerValue, validatePlayerValueId } from '../../types/domain/player-value.type';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';
import { PlayerValueHandlerResponse } from '../types';

export const createPlayerValueHandlers = (
  playerValueService: ServiceContainer['playerValueService'],
): PlayerValueHandlerResponse => ({
  getAllPlayerValues: () => {
    const task = playerValueService.getPlayerValues() as TE.TaskEither<ServiceError, PlayerValue[]>;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((playerValues) => [...playerValues]),
    );
  },

  getPlayerValueById: (req: Request) => {
    const playerValueId = req.params.id;
    const validatedId = validatePlayerValueId(playerValueId);

    if (validatedId._tag === 'Left') {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: validatedId.left,
        }),
      );
    }

    return pipe(
      playerValueService.getPlayerValue(validatedId.right) as TE.TaskEither<
        ServiceError,
        PlayerValue | null
      >,
      TE.mapLeft(toAPIError),
      TE.chain((playerValue) =>
        playerValue === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: `Player value with ID ${playerValueId} not found`,
              }),
            )
          : TE.right(playerValue),
      ),
    );
  },
});
