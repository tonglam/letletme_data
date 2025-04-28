import { PlayerValueTrackOperations } from 'domains/player-value-track/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  PlayerValueTrackCreateInputs,
  PlayerValueTrackRepository,
} from 'src/repositories/player-value-track/types';
import { PlayerValueTracks } from 'src/types/domain/player-value-track.type';
import { createDomainError } from 'src/types/error.type';
import { DomainErrorCode } from 'src/types/error.type';
import { DomainError } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

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
