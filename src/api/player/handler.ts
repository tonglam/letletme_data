import { Request } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerHandlerResponse } from 'src/api/player/types';

import { PlayerService } from '../../services/player/types';
import { Player, PlayerId, Players, validatePlayerId } from '../../types/domain/player.type';
import { APIError, APIErrorCode, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';

export const createPlayerHandlers = (playerService: PlayerService): PlayerHandlerResponse => {
  const getAllPlayers = (): TE.TaskEither<APIError, Player[]> => {
    return pipe(
      playerService.getPlayers(),
      TE.mapLeft(toAPIError),
      TE.map((players: Players) => [...players]),
    );
  };

  const getPlayerByElement = (req: Request): TE.TaskEither<APIError, Player> => {
    const elementParam = req.params.id;
    const parsedElement = parseInt(elementParam);

    if (isNaN(parsedElement)) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid player element format: must be a numeric string',
        }),
      );
    }

    const validatedId = validatePlayerId(parsedElement);
    if (E.isLeft(validatedId)) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: validatedId.left,
        }),
      );
    }

    return pipe(
      playerService.getPlayer(validatedId.right as PlayerId),
      TE.mapLeft(toAPIError),
      TE.chain((player) =>
        player === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: `Player with ID ${validatedId.right} not found`,
              }),
            )
          : TE.right(player),
      ),
    );
  };

  return {
    getAllPlayers,
    getPlayerByElement,
  };
};
