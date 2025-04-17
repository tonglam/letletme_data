import { Request } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { ServiceContainer } from '../../services/types';
import { PlayerStat, validatePlayerStatId } from '../../types/domain/player-stat.type';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';
import { PlayerStatHandlerResponse } from '../types';

export const createPlayerStatHandlers = (
  playerStatService: ServiceContainer['playerStatService'],
): PlayerStatHandlerResponse => ({
  getAllPlayerStats: () => {
    const task = playerStatService.getPlayerStats() as TE.TaskEither<ServiceError, PlayerStat[]>;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((playerStats) => [...playerStats]),
    );
  },

  getPlayerStatById: (req: Request) => {
    const playerStatId = req.params.id;
    const validatedId = validatePlayerStatId(playerStatId);

    if (validatedId._tag === 'Left') {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: validatedId.left,
        }),
      );
    }

    return pipe(
      playerStatService.getPlayerStat(validatedId.right) as TE.TaskEither<
        ServiceError,
        PlayerStat | null
      >,
      TE.mapLeft(toAPIError),
      TE.chain((playerStat) =>
        playerStat === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: `Player stat with ID ${playerStatId} not found`,
              }),
            )
          : TE.right(playerStat),
      ),
    );
  },
});
