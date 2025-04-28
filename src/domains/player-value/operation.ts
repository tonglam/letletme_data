import { PlayerValueOperations } from 'domains/player-value/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  PlayerValueCreateInputs,
  PlayerValueRepository,
} from 'src/repositories/player-value/types';
import { RawPlayerValues } from 'src/types/domain/player-value.type';
import { PlayerId } from 'src/types/domain/player.type';
import { createDomainError, DomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerValueOperations = (
  repository: PlayerValueRepository,
): PlayerValueOperations => {
  const getLatestPlayerValuesByElements = (
    elementIds: ReadonlyArray<PlayerId>,
  ): TE.TaskEither<DomainError, ReadonlyArray<{ elementId: PlayerId; value: number }>> =>
    pipe(
      repository.getLatestPlayerValuesByElements(elementIds),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getLatestPlayerValuesByElements): ${getErrorMessage(dbError)}`,
        }),
      ),
    );

  const getPlayerValuesByChangeDate = (
    changeDate: string,
  ): TE.TaskEither<DomainError, RawPlayerValues> =>
    pipe(
      repository.findByChangeDate(changeDate),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getPlayerValuesByChangeDate): ${getErrorMessage(dbError)}`,
        }),
      ),
    );

  const getPlayerValuesByElement = (
    elementId: PlayerId,
  ): TE.TaskEither<DomainError, RawPlayerValues> =>
    pipe(
      repository.findByElement(elementId),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getPlayerValuesByElement): ${getErrorMessage(dbError)}`,
        }),
      ),
    );

  const getPlayerValuesByElements = (
    elementIds: ReadonlyArray<PlayerId>,
  ): TE.TaskEither<DomainError, RawPlayerValues> =>
    pipe(
      repository.findByElements(elementIds),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (getPlayerValuesByElements): ${getErrorMessage(dbError)}`,
        }),
      ),
    );

  const savePlayerValueChanges = (
    playerValueInputs: PlayerValueCreateInputs,
  ): TE.TaskEither<DomainError, RawPlayerValues> =>
    pipe(
      repository.savePlayerValueChangesByChangeDate(playerValueInputs),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (savePlayerValueChanges): ${getErrorMessage(dbError)}`,
        }),
      ),
    );

  return {
    getLatestPlayerValuesByElements,
    getPlayerValuesByChangeDate,
    getPlayerValuesByElement,
    getPlayerValuesByElements,
    savePlayerValueChanges,
  };
};
