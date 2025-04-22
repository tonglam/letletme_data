import { PlayerValueOperations } from 'domains/player-value/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValueCreateInputs, PlayerValueRepository } from 'src/repositories/player-value/type';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { createDomainError, DomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerValueOperations = (
  repository: PlayerValueRepository,
): PlayerValueOperations => {
  const getLatestPlayerValuesByElements = (
    elements: readonly number[],
  ): TE.TaskEither<DomainError, ReadonlyArray<{ element: number; value: number }>> =>
    pipe(
      repository.getLatestPlayerValuesByElements(elements),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getLatestPlayerValuesByElements): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const getPlayerValuesByChangeDate = (
    changeDate: string,
  ): TE.TaskEither<DomainError, SourcePlayerValues> =>
    pipe(
      repository.findByChangeDate(changeDate),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getPlayerValuesByChangeDate): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const getPlayerValuesByElement = (
    element: number,
  ): TE.TaskEither<DomainError, SourcePlayerValues> =>
    pipe(
      repository.findByElement(element),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getPlayerValuesByElement): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const getPlayerValuesByElements = (
    elements: number[],
  ): TE.TaskEither<DomainError, SourcePlayerValues> =>
    pipe(
      repository.findByElements(elements),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getPlayerValuesByElements): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const savePlayerValueChanges = (
    playerValues: PlayerValueCreateInputs,
  ): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.savePlayerValueChanges(playerValues),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (savePlayerValueChanges): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const deletePlayerValuesByChangeDate = (changeDate: string): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.deleteByChangeDate(changeDate),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deletePlayerValuesByChangeDate): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  return {
    getLatestPlayerValuesByElements,
    getPlayerValuesByChangeDate,
    getPlayerValuesByElement,
    getPlayerValuesByElements,
    savePlayerValueChanges,
    deletePlayerValuesByChangeDate,
  };
};
