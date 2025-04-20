import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { PlayerValue, PlayerValues } from 'src/types/domain/player-value.type';
import { DomainError } from 'src/types/error.type';

export { PlayerValue }; // Re-export the type

export interface PlayerValueCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly changeDate: string;
}

export interface PlayerValueCache {
  readonly getPlayerValuesByChangeDate: (
    changeDate: string,
  ) => TE.TaskEither<DomainError, PlayerValues>;
  readonly setPlayerValuesByChangeDate: (
    changeDate: string,
    playerValues: PlayerValues,
  ) => TE.TaskEither<DomainError, void>;
}
