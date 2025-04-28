import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValueCreateInputs } from 'repository/player-value/types';
import { PlayerValues, RawPlayerValues } from 'types/domain/player-value.type';
import { PlayerId } from 'types/domain/player.type';
import { DomainError } from 'types/error.type';

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
