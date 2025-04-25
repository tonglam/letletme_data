import * as TE from 'fp-ts/TaskEither';
import { CachePrefix, DefaultTTL } from 'src/configs/cache/cache.config';
import { PlayerCreateInputs } from 'src/repositories/player/types';
import { Players, RawPlayers } from 'src/types/domain/player.type';
import { DomainError } from 'src/types/error.type';

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
