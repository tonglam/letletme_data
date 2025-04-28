import * as TE from 'fp-ts/TaskEither';
import { CachePrefix, DefaultTTL } from 'src/configs/cache/cache.config';
import { PlayerValueCreateInputs } from 'src/repositories/player-value/types';
import { PlayerValues, RawPlayerValues } from 'src/types/domain/player-value.type';
import { PlayerId } from 'src/types/domain/player.type';
import { DomainError } from 'src/types/error.type';

export type PlayerValueCacheConfig = {
  keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
};

export type PlayerValueCache = {
  getPlayerValuesByChangeDate: (changeDate: string) => TE.TaskEither<DomainError, PlayerValues>;
  setPlayerValuesByChangeDate: (playerValues: PlayerValues) => TE.TaskEither<DomainError, void>;
};

export interface PlayerValueOperations {
  readonly getLatestPlayerValuesByElements: (
    elementIds: ReadonlyArray<PlayerId>,
  ) => TE.TaskEither<DomainError, ReadonlyArray<{ elementId: PlayerId; value: number }>>;
  readonly getPlayerValuesByChangeDate: (
    changeDate: string,
  ) => TE.TaskEither<DomainError, RawPlayerValues>;
  readonly getPlayerValuesByElement: (
    elementId: PlayerId,
  ) => TE.TaskEither<DomainError, RawPlayerValues>;
  readonly getPlayerValuesByElements: (
    elementIds: ReadonlyArray<PlayerId>,
  ) => TE.TaskEither<DomainError, RawPlayerValues>;
  readonly savePlayerValueChanges: (
    playerValueInputs: PlayerValueCreateInputs,
  ) => TE.TaskEither<DomainError, RawPlayerValues>;
}
