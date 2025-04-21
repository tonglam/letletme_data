import { PlayerValueOperations } from 'domains/player-value/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValueCreateInputs, PlayerValueRepository } from 'src/repositories/player-value/type';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { createDomainError, DomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerValueOperations = (
  repository: PlayerValueRepository,
): PlayerValueOperations => ({
  getPlayerValuesByElement: (element: number): TE.TaskEither<DomainError, SourcePlayerValues> =>
    pipe(
      repository.findByElement(element),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getPlayerValuesByElement): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),

  getPlayerValuesByElements: (elements: number[]): TE.TaskEither<DomainError, SourcePlayerValues> =>
    pipe(
      repository.findByElements(elements),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getPlayerValuesByElements): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),

  savePlayerValues: (
    playerValues: PlayerValueCreateInputs,
  ): TE.TaskEither<DomainError, SourcePlayerValues> =>
    pipe(
      repository.saveBatch(playerValues),
      TE.map(() => playerValues),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (savePlayerValues): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),

  deletePlayerValuesByChangeDate: (changeDate: string): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.deleteByChangeDate(changeDate),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deletePlayerValuesByChangeDate): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),

  deleteAllPlayerValues: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAllPlayerValues): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),
});
