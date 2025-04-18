import { Request } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { PlayerStatService } from '../../services/player-stat/types';
import {
  PlayerStat,
  PlayerStats,
  validatePlayerStatIdInput,
} from '../../types/domain/player-stat.type';
import { APIError, APIErrorCode, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';
import { PlayerStatHandlerResponse } from '../types';

export const createPlayerStatHandlers = (
  playerStatService: PlayerStatService,
): PlayerStatHandlerResponse => ({
  getAllPlayerStats: (): TE.TaskEither<APIError, PlayerStat[]> => {
    return pipe(
      playerStatService.getPlayerStats(),
      TE.mapLeft(toAPIError),
      TE.map((playerStats: PlayerStats) => [...playerStats]),
    );
  },

  getPlayerStatById: (req: Request): TE.TaskEither<APIError, PlayerStat> => {
    const playerStatIdInput = req.params.id;
    const validatedId = validatePlayerStatIdInput(playerStatIdInput);

    if (E.isLeft(validatedId)) {
      return TE.left(
        createAPIError({ code: APIErrorCode.VALIDATION_ERROR, message: validatedId.left }),
      );
    }

    return pipe(
      playerStatService.getPlayerStat(validatedId.right),
      TE.mapLeft(toAPIError),
      TE.chain((playerStat) =>
        playerStat === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: `Player stat with ID ${playerStatIdInput} not found`,
              }),
            )
          : TE.right(playerStat),
      ),
    );
  },
});
