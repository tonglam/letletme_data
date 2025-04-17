import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { PrismaPlayerCreate } from 'src/repositories/player/type';
import { Player, PlayerId, Players } from 'src/types/domain/player.type';
import { DBError, DomainError } from 'src/types/error.type';

// ============ Repository Types ============

export interface PlayerRepository {
  readonly findAll: () => TE.TaskEither<DBError, Players>;
  readonly findById: (id: PlayerId) => TE.TaskEither<DBError, Player | null>;
  readonly saveBatch: (players: readonly PrismaPlayerCreate[]) => TE.TaskEither<DBError, Players>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}

// ============ Cache Types ============

export interface PlayerCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface PlayerCache {
  readonly getPlayer: (id: PlayerId) => TE.TaskEither<DomainError, Player | null>;
  readonly getAllPlayers: () => TE.TaskEither<DomainError, Players | null>;
  readonly setAllPlayers: (players: Players) => TE.TaskEither<DomainError, void>;
  readonly deleteAllPlayers: () => TE.TaskEither<DomainError, void>;
}

// ============ Operations Types ============

export interface PlayerOperations {
  readonly getAllPlayers: () => TE.TaskEither<DomainError, Players>;
  readonly getPlayerById: (id: PlayerId) => TE.TaskEither<DomainError, Player | null>;
  readonly savePlayers: (
    players: readonly PrismaPlayerCreate[],
  ) => TE.TaskEither<DomainError, Players>;
  readonly deleteAllPlayers: () => TE.TaskEither<DomainError, void>;
}
