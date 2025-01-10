// Player Stat Handlers Module
//
// Provides handlers for player stat-related API endpoints using functional programming
// patterns with fp-ts. Handles player stat retrieval operations including getting all player stats
// and specific player stats by ID.

import { Request } from 'express';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { toAPIError } from 'src/utils/error.util';
import { ServiceContainer, ServiceKey } from '../../service';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { PlayerStat, validatePlayerStatId } from '../../types/player-stat.type';
import { PlayerStatHandlerResponse } from '../types';

// Creates player stat handlers with dependency injection
export const createPlayerStatHandlers = (
  playerStatService: ServiceContainer[typeof ServiceKey.PLAYER_STAT],
): PlayerStatHandlerResponse => ({
  // Retrieves all player stats
  getAllPlayerStats: () => {
    const task = playerStatService.getPlayerStats() as unknown as TE.TaskEither<
      ServiceError,
      PlayerStat[]
    >;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((playerStats) => playerStats.slice()),
    );
  },

  // Retrieves a specific player stat by ID
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

    const task = playerStatService.getPlayerStat(validatedId.right) as unknown as TE.TaskEither<
      ServiceError,
      PlayerStat | null
    >;
    return pipe(
      task,
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
