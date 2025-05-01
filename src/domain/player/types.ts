import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { Players } from 'types/domain/player.type';
import { CacheError } from 'types/error.type';

export interface PlayerCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface PlayerCache {
  readonly getAllPlayers: () => TE.TaskEither<CacheError, Players>;
  readonly setAllPlayers: (players: Players) => TE.TaskEither<CacheError, void>;
}
