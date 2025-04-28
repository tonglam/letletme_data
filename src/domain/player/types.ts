import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { PlayerCreateInputs } from 'repository/player/types';
import { Players, RawPlayers } from 'types/domain/player.type';
import { DomainError } from 'types/error.type';

export interface PlayerCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface PlayerCache {
  readonly getAllPlayers: () => TE.TaskEither<DomainError, Players>;
  readonly setAllPlayers: (players: Players) => TE.TaskEither<DomainError, void>;
}

export interface PlayerOperations {
  readonly savePlayers: (
    playerInputs: PlayerCreateInputs,
  ) => TE.TaskEither<DomainError, RawPlayers>;
  readonly deleteAllPlayers: () => TE.TaskEither<DomainError, void>;
}
