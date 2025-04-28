import { PlayerOperations } from 'domains/player/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerCreateInputs, PlayerRepository } from 'repositories/player/types';
import { RawPlayers } from 'types/domain/player.type';
import { createDomainError, DomainError, DomainErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createPlayerOperations = (repository: PlayerRepository): PlayerOperations => {
  const savePlayers = (playerInputs: PlayerCreateInputs): TE.TaskEither<DomainError, RawPlayers> =>
    pipe(
      repository.saveBatch(playerInputs),
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
