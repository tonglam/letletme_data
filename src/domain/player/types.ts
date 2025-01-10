/**
 * Player Domain Types Module
 *
 * Re-exports core type definitions from the types layer.
 */

import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/config/cache/cache.config';
import { APIError, CacheError, DomainError } from 'src/types/error.type';
import { Player, PlayerId, PlayerRepository, Players } from 'src/types/player.type';
import { BootstrapApi } from '../bootstrap/types';

/**
 * Player data provider interface
 */
export interface PlayerDataProvider {
  readonly getOne: (id: number) => Promise<Player | null>;
  readonly getAll: () => Promise<readonly Player[]>;
}

/**
 * Player cache configuration interface
 */
export interface PlayerCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

/**
 * Player cache interface
 */
export interface PlayerCache {
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
  readonly cachePlayer: (player: Player) => TE.TaskEither<CacheError, void>;
  readonly cachePlayers: (players: readonly Player[]) => TE.TaskEither<CacheError, void>;
  readonly getPlayer: (id: string) => TE.TaskEither<CacheError, Player | null>;
  readonly getAllPlayers: () => TE.TaskEither<CacheError, readonly Player[]>;
}

/**
 * Player operations interface for domain logic
 */
export interface PlayerOperations {
  readonly getAllPlayers: () => TE.TaskEither<DomainError, Players>;
  readonly getPlayerById: (id: PlayerId) => TE.TaskEither<DomainError, Player | null>;
  readonly createPlayers: (players: Players) => TE.TaskEither<DomainError, Players>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

/**
 * Service interface for Player operations
 */
export interface PlayerService {
  readonly getPlayers: () => TE.TaskEither<APIError, Players>;
  readonly getPlayer: (id: PlayerId) => TE.TaskEither<APIError, Player | null>;
  readonly savePlayers: (players: Players) => TE.TaskEither<APIError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<APIError, Players>;
}

/**
 * Dependencies required by the PlayerService
 */
export interface PlayerServiceDependencies {
  bootstrapApi: BootstrapApi;
  playerCache: PlayerCache;
  playerRepository: PlayerRepository;
}

export * from '../../types/player.type';
