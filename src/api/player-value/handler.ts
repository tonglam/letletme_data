import { Request } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValueHandlerResponse } from 'src/api/player-value/types';
import { PlayerId } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';

import { PlayerValueService } from '../../services/player-value/types';
import { PlayerValues } from '../../types/domain/player-value.type';
import { APIError, APIErrorCode, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';

const validateChangeDate = (dateStr: unknown): E.Either<string, string> => {
  if (typeof dateStr === 'string' && /^[0-9]{8}$/.test(dateStr.trim())) {
    return E.right(dateStr.trim());
  }
  return E.left('Invalid change date format: must be an 8-digit string (YYYYMMDD)');
};

export const createPlayerValueHandlers = (
  playerValueService: PlayerValueService,
): PlayerValueHandlerResponse => {
  const syncPlayerValues = (): TE.TaskEither<APIError, void> => {
    return pipe(playerValueService.syncPlayerValuesFromApi(), TE.mapLeft(toAPIError));
  };

  const getPlayerValuesByChangeDate = (req: Request): TE.TaskEither<APIError, PlayerValues> => {
    const changeDateParam = req.params.changeDate;
    const validatedDate = validateChangeDate(changeDateParam);

    if (E.isLeft(validatedDate)) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: validatedDate.left,
        }),
      );
    }

    return pipe(
      playerValueService.getPlayerValuesByChangeDate(changeDateParam),
      TE.mapLeft(toAPIError),
    );
  };

  const getPlayerValuesByElement = (req: Request): TE.TaskEither<APIError, PlayerValues> => {
    const elementParam = req.params.element;
    const parsedElement = parseInt(elementParam) as PlayerId;

    if (isNaN(parsedElement)) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid player element format: must be a numeric string',
        }),
      );
    }

    return pipe(playerValueService.getPlayerValuesByElement(parsedElement), TE.mapLeft(toAPIError));
  };

  const getPlayerValuesByTeam = (req: Request): TE.TaskEither<APIError, PlayerValues> => {
    const teamParam = req.params.team;
    const parsedTeam = parseInt(teamParam) as TeamId;

    if (isNaN(parsedTeam)) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid team format: must be a numeric string',
        }),
      );
    }

    return pipe(playerValueService.getPlayerValuesByTeam(parsedTeam), TE.mapLeft(toAPIError));
  };

  return {
    getPlayerValuesByChangeDate,
    getPlayerValuesByElement,
    getPlayerValuesByTeam,
    syncPlayerValues,
  };
};
