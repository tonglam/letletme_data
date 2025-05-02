import { PlayerValueTrackOperations } from 'domain/player-value-track/types';

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  PlayerValueTrackCreateInputs,
  PlayerValueTrackRepository,
} from 'repository/player-value-track/types';
import { PlayerValueTracks } from 'types/domain/player-value-track.type';
import { DomainError, DomainErrorCode, createDomainError } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createPlayerValueTrackOperations = (
  repository: PlayerValueTrackRepository,
): PlayerValueTrackOperations => {
  const getPlayerValueTracksByDate = (
    date: string,
  ): TE.TaskEither<DomainError, PlayerValueTracks> =>
    pipe(
      repository.findByDate(date),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getPlayerValueTracksByDate): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const savePlayerValueTracksByDate = (
    playerValueTracks: PlayerValueTrackCreateInputs,
  ): TE.TaskEither<DomainError, PlayerValueTracks> =>
    pipe(
      repository.savePlayerValueTracksByDate(playerValueTracks),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (savePlayerValueTracksByDate): ${getErrorMessage(dbError)}`,
        }),
      ),
    );

  return {
    getPlayerValueTracksByDate,
    savePlayerValueTracksByDate,
  };
};
