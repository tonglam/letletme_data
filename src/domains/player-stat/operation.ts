import { PlayerStatOperations } from 'domains/player-stat/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatRepository } from 'src/repositories/player-stat/type';
import { PlayerStats } from 'src/types/domain/player-stat.type';
import { createDomainError, DomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerStatOperations = (
  repository: PlayerStatRepository,
): PlayerStatOperations => ({
  savePlayerStats: (playerStats: PlayerStats): TE.TaskEither<DomainError, PlayerStats> =>
    pipe(
      repository.saveBatch(playerStats),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
        }),
      ),
    ),

  deleteAllPlayerStats: (): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),
});
