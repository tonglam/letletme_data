// Player Handlers Module
//
// Provides handlers for player-related API endpoints using functional programming
// patterns with fp-ts. Handles player retrieval operations including getting all players
// and specific players by ID.

import { Request } from 'express';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { toAPIError } from 'src/utils/error.util';
import { ServiceContainer, ServiceKey } from '../../service';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { Player, validatePlayerId } from '../../types/player.type';
import { PlayerHandlerResponse } from '../types';

// Creates player handlers with dependency injection
export const createPlayerHandlers = (
  playerService: ServiceContainer[typeof ServiceKey.PLAYER],
): PlayerHandlerResponse => ({
  // Retrieves all players
  getAllPlayers: () => {
    const task = playerService.getPlayers() as unknown as TE.TaskEither<ServiceError, Player[]>;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((players) => players.slice()),
    );
  },

  // Retrieves a specific player by ID
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

    const task = playerService.getPlayer(validatedId.right) as unknown as TE.TaskEither<
      ServiceError,
      Player | null
    >;
    return pipe(
      task,
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
