import { Request } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { ServiceContainer } from '../../services/types';
import { Player, validatePlayerId } from '../../types/domain/player.type';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';
import { PlayerHandlerResponse } from '../types';

export const createPlayerHandlers = (
  playerService: ServiceContainer['playerService'],
): PlayerHandlerResponse => ({
  getAllPlayers: () => {
    const task = playerService.getPlayers() as TE.TaskEither<ServiceError, Player[]>;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((players) => [...players]),
    );
  },

  getPlayerById: (req: Request) => {
    const playerId = Number(req.params.id);
    const validatedId = validatePlayerId(playerId);

    if (validatedId._tag === 'Left') {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: validatedId.left,
        }),
      );
    }

    return pipe(
      playerService.getPlayer(validatedId.right) as TE.TaskEither<ServiceError, Player | null>,
      TE.mapLeft(toAPIError),
      TE.chain((player) =>
        player === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: `Player with ID ${playerId} not found`,
              }),
            )
          : TE.right(player),
      ),
    );
  },
});
