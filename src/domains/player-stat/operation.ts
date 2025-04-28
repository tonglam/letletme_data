import { PlayerStatOperations } from 'domains/player-stat/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatCreateInputs, PlayerStatRepository } from 'repositories/player-stat/types';
import { RawPlayerStats } from 'types/domain/player-stat.type';
import { DomainError, DomainErrorCode, createDomainError } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createPlayerStatOperations = (
  repository: PlayerStatRepository,
): PlayerStatOperations => {
  const getLatestPlayerStats = (): TE.TaskEither<DomainError, RawPlayerStats> =>
    pipe(
      repository.findLatest(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findLatest): ${getErrorMessage(dbError)}`,
        }),
      ),
    );

  const saveLatestPlayerStats = (
    playerStatInputs: PlayerStatCreateInputs,
  ): TE.TaskEither<DomainError, RawPlayerStats> =>
    pipe(
      repository.saveLatest(playerStatInputs),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveLatest): ${getErrorMessage(dbError)}`,
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
        }),
      ),
    );

  return {
    getLatestPlayerStats,
    saveLatestPlayerStats,
    deleteLatestPlayerStats,
  };
};
