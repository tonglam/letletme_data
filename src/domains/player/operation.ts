import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerCreateInputs, PlayerRepository } from 'src/repositories/player/type';
import { createDomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

import { PlayerOperations } from './types';

export const createPlayerOperations = (repository: PlayerRepository): PlayerOperations => ({
  savePlayers: (players: PlayerCreateInputs) =>
    pipe(
      repository.saveBatch(players),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
        }),
      ),
    ),

  deleteAllPlayers: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
        }),
      ),
    ),
});
