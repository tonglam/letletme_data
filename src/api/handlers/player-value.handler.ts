// Player Value Handlers Module
//
// Provides handlers for player value-related API endpoints using functional programming
// patterns with fp-ts. Handles player value retrieval operations including getting all player values
// and specific player values by ID.

import { Request } from 'express';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { toAPIError } from 'src/utils/error.util';
import { ServiceContainer, ServiceKey } from '../../service';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { PlayerValue, validatePlayerValueId } from '../../types/player-value.type';
import { PlayerValueHandlerResponse } from '../types';

// Creates player value handlers with dependency injection
export const createPlayerValueHandlers = (
  playerValueService: ServiceContainer[typeof ServiceKey.PLAYER_VALUE],
): PlayerValueHandlerResponse => ({
  // Retrieves all player values
  getAllPlayerValues: () => {
    const task = playerValueService.getPlayerValues() as unknown as TE.TaskEither<
      ServiceError,
      PlayerValue[]
    >;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((playerValues) => playerValues.slice()),
    );
  },

  // Retrieves a specific player value by ID
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

    const task = playerValueService.getPlayerValue(validatedId.right) as unknown as TE.TaskEither<
      ServiceError,
      PlayerValue | null
    >;
    return pipe(
      task,
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
