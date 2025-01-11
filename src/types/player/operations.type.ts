import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from '../../config/cache/cache.config';
import { BootstrapApi } from '../../domain/bootstrap/types';
import { APIError, CacheError, DomainError } from '../error.type';
import { Player, Players } from '../player.type';
import { TeamId } from '../team.type';
import { PlayerId } from './base.type';
import { PlayerView, PlayerViews } from './query.type';
import { PlayerRepository } from './repository.type';

/**
 * Domain Layer Types
 */

export interface PlayerCommandOperations {
  readonly getPlayerById: (id: PlayerId) => TE.TaskEither<DomainError, Player | null>;
  readonly createPlayers: (players: Players) => TE.TaskEither<DomainError, Players>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

export interface PlayerQueryOperations {
  readonly getPlayerWithTeam: (id: PlayerId) => TE.TaskEither<DomainError, PlayerView | null>;
  readonly getAllPlayersWithTeams: () => TE.TaskEither<DomainError, PlayerViews>;
  readonly getPlayersByTeam: (teamId: TeamId) => TE.TaskEither<DomainError, PlayerViews>;
}

/**
 * Cache Layer Types
 */

export interface PlayerDataProvider {
  readonly getOne: (id: number) => Promise<Player | null>;
  readonly getAll: () => Promise<readonly Player[]>;
}

export interface PlayerCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface PlayerCache {
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
  readonly cachePlayer: (player: Player) => TE.TaskEither<CacheError, void>;
  readonly cachePlayers: (players: readonly Player[]) => TE.TaskEither<CacheError, void>;
  readonly getPlayer: (id: string) => TE.TaskEither<CacheError, Player | null>;
  readonly getAllPlayers: () => TE.TaskEither<CacheError, readonly Player[]>;
}

/**
 * Service Layer Types
 */

export interface PlayerService {
  readonly getPlayers: () => TE.TaskEither<APIError, Players>;
  readonly getPlayer: (id: PlayerId) => TE.TaskEither<APIError, Player | null>;
  readonly savePlayers: (players: Players) => TE.TaskEither<APIError, Players>;
  readonly syncPlayersFromApi: () => TE.TaskEither<APIError, Players>;
}

export interface PlayerServiceDependencies {
  readonly bootstrapApi: BootstrapApi;
  readonly playerCache: PlayerCache;
  readonly playerRepository: PlayerRepository;
}
