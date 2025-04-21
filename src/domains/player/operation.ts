import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerCreateInputs, PlayerRepository } from 'src/repositories/player/type';
import { Players } from 'src/types/domain/player.type';
import { createDomainError, DomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

import { PlayerOperations } from './types';

export const createPlayerOperations = (repository: PlayerRepository): PlayerOperations => {
  const savePlayers = (players: PlayerCreateInputs): TE.TaskEither<DomainError, Players> =>
    pipe(
      repository.saveBatch(players),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
        }),
      ),
    );

  const deleteAllPlayers = (): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
        }),
      ),
    );

  return {
    savePlayers,
    deleteAllPlayers,
  };
};
