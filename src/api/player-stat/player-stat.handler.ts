import { Request } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { PlayerStatHandlerResponse } from './types';
import { PlayerStatService } from '../../services/player-stat/types';
import {
  PlayerStat,
  PlayerStats,
  validatePlayerStatIdInput,
} from '../../types/domain/player-stat.type';
import { APIError, APIErrorCode, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';

export const createPlayerStatHandlers = (
  playerStatService: PlayerStatService,
): PlayerStatHandlerResponse => {
  const getLatestPlayerStats = (): TE.TaskEither<APIError, PlayerStats> => {
    return pipe(
      playerStatService.getLatestPlayerStats(),
      TE.mapLeft(toAPIError),
      TE.map((playerStats: PlayerStats) => [...playerStats]),
    );
  };

  const syncPlayerStats = (): TE.TaskEither<APIError, void> => {
    return pipe(playerStatService.syncPlayerStatsFromApi(), TE.mapLeft(toAPIError));
  };

  const getPlayerStatsByElementType = (req: Request): TE.TaskEither<APIError, PlayerStats> => {
    const elementTypeParam = req.params.elementType;
    const parsedElementType = parseInt(elementTypeParam);

    if (isNaN(parsedElementType)) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid element type format: must be a numeric string',
        }),
      );
    }

    return pipe(
      playerStatService.getPlayerStatsByElementType(parsedElementType),
      TE.mapLeft(toAPIError),
    );
  };

  const getPlayerStatsByTeam = (req: Request): TE.TaskEither<APIError, PlayerStats> => {
    const teamParam = req.params.team;
    const parsedTeam = parseInt(teamParam);

    if (isNaN(parsedTeam)) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid team format: must be a numeric string',
        }),
      );
    }

    return pipe(playerStatService.getPlayerStatsByTeam(parsedTeam), TE.mapLeft(toAPIError));
  };

  const getPlayerStat = (req: Request): TE.TaskEither<APIError, PlayerStat> => {
    const playerStatIdInput = req.params.id;
    const validatedId = validatePlayerStatIdInput(playerStatIdInput);

    if (E.isLeft(validatedId)) {
      return TE.left(
        createAPIError({ code: APIErrorCode.VALIDATION_ERROR, message: validatedId.left }),
      );
    }

    return pipe(playerStatService.getPlayerStat(validatedId.right), TE.mapLeft(toAPIError));
  };

  return {
    getPlayerStats: getLatestPlayerStats,
    syncPlayerStats,
    getPlayerStatsByElementType,
    getPlayerStatsByTeam,
    getPlayerStat,
  };
};
