import { PlayerStatOperations } from 'domains/player-stat/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatCreateInputs, PlayerStatRepository } from 'src/repositories/player-stat/type';
import { SourcePlayerStats } from 'src/types/domain/player-stat.type';
import { DomainError, DomainErrorCode, createDomainError } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerStatOperations = (
  repository: PlayerStatRepository,
): PlayerStatOperations => {
  const getLatestPlayerStats = (): TE.TaskEither<DomainError, SourcePlayerStats> =>
    pipe(
      repository.findLatest(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findLatest): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const saveLatestPlayerStats = (
    playerStats: PlayerStatCreateInputs,
  ): TE.TaskEither<DomainError, SourcePlayerStats> =>
    pipe(
      repository.saveLatest(playerStats),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveLatest): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const deleteLatestPlayerStats = (): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.deleteLatest(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteLatest): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  return {
    getLatestPlayerStats,
    saveLatestPlayerStats,
    deleteLatestPlayerStats,
  };
};
