import * as TE from 'fp-ts/TaskEither';
import { PlayerValueCreateInputs } from 'src/repositories/player-value/type';
import { PlayerValues, SourcePlayerValues } from 'src/types/domain/player-value.type';
import { DomainError } from 'src/types/error.type';

export type PlayerValueCacheConfig = {
  keyPrefix: string;
  ttlSeconds: number;
};

export type PlayerValueCache = {
  getPlayerValuesByChangeDate: (changeDate: string) => TE.TaskEither<DomainError, PlayerValues>;
  setPlayerValuesByChangeDate: (
    changeDate: string,
    playerValues: PlayerValues,
  ) => TE.TaskEither<DomainError, void>;
};

export interface PlayerValueOperations {
  readonly getLatestPlayerValuesByElements: (
    elements: readonly number[],
  ) => TE.TaskEither<DomainError, ReadonlyArray<{ element: number; value: number }>>;
  readonly getPlayerValuesByChangeDate: (
    changeDate: string,
  ) => TE.TaskEither<DomainError, SourcePlayerValues>;
  readonly getPlayerValuesByElement: (
    element: number,
  ) => TE.TaskEither<DomainError, SourcePlayerValues>;
  readonly getPlayerValuesByElements: (
    elements: number[],
  ) => TE.TaskEither<DomainError, SourcePlayerValues>;
  readonly savePlayerValueChanges: (
    playerValues: PlayerValueCreateInputs,
  ) => TE.TaskEither<DomainError, void>;
  readonly deletePlayerValuesByChangeDate: (changeDate: string) => TE.TaskEither<DomainError, void>;
}
