import { Request } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { PlayerValueService } from '../../services/player-value/types';
import {
  PlayerValue,
  PlayerValues,
  validatePlayerValueIdInput,
} from '../../types/domain/player-value.type';
import { APIError, APIErrorCode, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';
import { PlayerValueHandlerResponse } from '../types';

export const createPlayerValueHandlers = (
  playerValueService: PlayerValueService,
): PlayerValueHandlerResponse => ({
  getAllPlayerValues: (): TE.TaskEither<APIError, PlayerValue[]> => {
    return pipe(
      playerValueService.getPlayerValues(),
      TE.mapLeft(toAPIError),
      TE.map((playerValues: PlayerValues) => [...playerValues]),
    );
  },

  getPlayerValueById: (req: Request): TE.TaskEither<APIError, PlayerValue> => {
    const playerValueIdInput = req.params.id;
    const validatedId = validatePlayerValueIdInput(playerValueIdInput);

    if (E.isLeft(validatedId)) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: validatedId.left,
        }),
      );
    }

    return pipe(
      playerValueService.getPlayerValues(validatedId.right),
      TE.mapLeft(toAPIError),
      TE.chain((playerValue) =>
        playerValue === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: `Player value with ID ${playerValueIdInput} not found`,
              }),
            )
          : TE.right(playerValue),
      ),
    );
  },
});
