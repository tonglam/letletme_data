import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { type BaseDataProvider } from '../../infrastructure/cache/core/cache';
import {
  createDomainCache,
  type DomainCacheOperations,
} from '../../infrastructure/cache/core/domain-cache';
import { createCacheInvalidation } from '../../infrastructure/cache/core/invalidation';
import {
  CacheError,
  CacheOperations,
  DomainType,
  RedisClient,
} from '../../infrastructure/cache/types';
import { Player } from '../../types/players.type';

export type PlayerDataProvider = BaseDataProvider<Player>;

export interface PlayerCacheOperations extends DomainCacheOperations<Player> {
  readonly getPlayers: () => TE.TaskEither<CacheError, readonly Player[]>;
  readonly setPlayers: (players: readonly Player[]) => TE.TaskEither<CacheError, void>;
  readonly getPlayer: (id: number) => TE.TaskEither<CacheError, Player | null>;
  readonly setPlayer: (id: number, player: Player) => TE.TaskEither<CacheError, void>;
  readonly setMany: (players: readonly Player[]) => TE.TaskEither<CacheError, void>;
  readonly remove: (id: number) => TE.TaskEither<CacheError, void>;
}

export const createPlayerOperations = (
  redis: RedisClient,
  dataProvider: PlayerDataProvider,
): PlayerCacheOperations => {
  const createKey = (id?: number) => (id ? `players:${id}` : 'players:all');

  const domainCache = createDomainCache(redis, 'PLAYER', dataProvider, 'player', (baseOps) => ({
    ...baseOps,
    getPlayers: () =>
      TE.tryCatch(
        async () => {
          const result = await redis.get(createKey())();
          return result._tag === 'Right' && result.right._tag === 'Some'
            ? (JSON.parse(result.right.value) as readonly Player[])
            : [];
        },
        (error) => ({
          type: 'OPERATION',
          message: `Failed to get players: ${error}`,
        }),
      ),
    setPlayers: (players: readonly Player[]) =>
      TE.tryCatch(
        async () => {
          await redis.set(createKey(), JSON.stringify(players))();
        },
        (error) => ({
          type: 'OPERATION',
          message: `Failed to set players: ${error}`,
        }),
      ),
    getPlayer: (id: number) =>
      TE.tryCatch(
        async () => {
          const result = await redis.get(createKey(id))();
          return result._tag === 'Right' && result.right._tag === 'Some'
            ? (JSON.parse(result.right.value) as Player)
            : null;
        },
        (error) => ({
          type: 'OPERATION',
          message: `Failed to get player: ${error}`,
        }),
      ),
    setPlayer: (id: number, player: Player) =>
      TE.tryCatch(
        async () => {
          await redis.set(createKey(id), JSON.stringify(player))();
        },
        (error) => ({
          type: 'OPERATION',
          message: `Failed to set player: ${error}`,
        }),
      ),
    setMany: (players: readonly Player[]) =>
      pipe(
        redis.multi(),
        TE.chain((multi) =>
          TE.tryCatch(
            async () => {
              players.forEach((player) => {
                multi.set(createKey(player.id), JSON.stringify(player));
              });
              await redis.exec(multi)();
            },
            (error) => ({
              type: 'OPERATION',
              message: `Failed to set multiple players: ${error}`,
            }),
          ),
        ),
      ),
    remove: (id: number) =>
      TE.tryCatch(
        async () => {
          await redis.del(createKey(id))();
        },
        (error) => ({
          type: 'OPERATION',
          message: `Failed to remove player: ${error}`,
        }),
      ),
  }));

  return domainCache as PlayerCacheOperations;
};

export const createPlayerInvalidation = (cache: CacheOperations) => ({
  ...createCacheInvalidation(cache, DomainType.PLAYER),
});

export type PlayerCache = ReturnType<typeof createPlayerOperations>;
