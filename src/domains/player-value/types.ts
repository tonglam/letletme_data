import * as TE from 'fp-ts/TaskEither';
import { PlayerValueCreateInputs } from 'src/repositories/player-value/type';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { DomainError } from 'src/types/error.type';

export type PlayerValueCacheConfig = {
  keyPrefix: string;
  ttlSeconds: number;
};

export type PlayerValueCache = {
  getPlayerValuesByChangeDate: (
    changeDate: string,
  ) => TE.TaskEither<DomainError, SourcePlayerValues>;
  setPlayerValuesByChangeDate: (
    changeDate: string,
    playerValues: SourcePlayerValues,
  ) => TE.TaskEither<DomainError, void>;
};

export interface PlayerValueOperations {
  readonly savePlayerValues: (
    playerValues: PlayerValueCreateInputs,
  ) => TE.TaskEither<DomainError, SourcePlayerValues>;
  readonly getPlayerValuesByElement: (
    element: number,
  ) => TE.TaskEither<DomainError, SourcePlayerValues>;
  readonly getPlayerValuesByElements: (
    elements: number[],
  ) => TE.TaskEither<DomainError, SourcePlayerValues>;
  readonly deletePlayerValuesByChangeDate: (changeDate: string) => TE.TaskEither<DomainError, void>;
  readonly deleteAllPlayerValues: () => TE.TaskEither<DomainError, void>;
}
