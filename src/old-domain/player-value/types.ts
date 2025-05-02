import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValues } from 'types/domain/player-value.type';
import { CacheError } from 'types/error.type';

export type PlayerValueCacheConfig = {
  keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
};

export type PlayerValueCache = {
  getPlayerValuesByChangeDate: (changeDate: string) => TE.TaskEither<CacheError, PlayerValues>;
  setPlayerValuesByChangeDate: (playerValues: PlayerValues) => TE.TaskEither<CacheError, void>;
};
