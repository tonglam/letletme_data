import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { PlayerValueCreateInputs } from 'src/repositories/player-value/type';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { DomainError } from 'src/types/error.type';

export interface PlayerValueCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly changeDate: string;
}

export interface PlayerValueCache {
  readonly getPlayerValuesByChangeDate: () => TE.TaskEither<DomainError, SourcePlayerValues>;
  readonly setPlayerValuesByChangeDate: (
    playerValues: SourcePlayerValues,
  ) => TE.TaskEither<DomainError, void>;
}

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
