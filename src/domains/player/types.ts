import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { PlayerCreateInputs } from 'src/repositories/player/type';
import { Players } from 'src/types/domain/player.type';
import { DomainError } from 'src/types/error.type';

export interface PlayerCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface PlayerCache {
  readonly getAllPlayers: () => TE.TaskEither<DomainError, Players>;
  readonly setAllPlayers: (players: Players) => TE.TaskEither<DomainError, void>;
  readonly deleteAllPlayers: () => TE.TaskEither<DomainError, void>;
}

export interface PlayerOperations {
  readonly savePlayers: (players: PlayerCreateInputs) => TE.TaskEither<DomainError, Players>;
  readonly deleteAllPlayers: () => TE.TaskEither<DomainError, void>;
}
