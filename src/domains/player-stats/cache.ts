import * as TE from 'fp-ts/TaskEither';
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
import { PlayerStat } from '../../types/player-stats.type';

export type PlayerStatDataProvider = BaseDataProvider<PlayerStat>;

export interface PlayerStatCacheOperations extends DomainCacheOperations<PlayerStat> {
  readonly getPlayerStats: (
    playerId: number,
    eventId: number,
  ) => TE.TaskEither<CacheError, readonly PlayerStat[]>;
  readonly setPlayerStats: (
    playerId: number,
    eventId: number,
    stats: readonly PlayerStat[],
  ) => TE.TaskEither<CacheError, void>;
  readonly getLatestPlayerStats: (playerId: number) => TE.TaskEither<CacheError, PlayerStat | null>;
  readonly setLatestPlayerStats: (
    playerId: number,
    stats: PlayerStat,
  ) => TE.TaskEither<CacheError, void>;
}

export const createPlayerStatsOperations = (
  redis: RedisClient,
  dataProvider: PlayerStatDataProvider,
): PlayerStatCacheOperations => {
  const createKey = (playerId: number, eventId?: number) =>
    eventId ? `player:${playerId}:stats:event:${eventId}` : `player:${playerId}:stats:latest`;

  const domainCache = createDomainCache(
    redis,
    'PLAYER_STAT',
    dataProvider,
    'player-stat',
    (baseOps) => ({
      ...baseOps,
      getPlayerStats: (playerId: number, eventId: number) =>
        TE.tryCatch(
          async () => {
            const result = await redis.get(createKey(playerId, eventId))();
            return result._tag === 'Right' && result.right._tag === 'Some'
              ? (JSON.parse(result.right.value) as readonly PlayerStat[])
              : [];
          },
          (error) => ({
            type: 'OPERATION',
            message: `Failed to get player stats: ${error}`,
          }),
        ),
      setPlayerStats: (playerId: number, eventId: number, stats: readonly PlayerStat[]) =>
        TE.tryCatch(
          async () => {
            await redis.set(createKey(playerId, eventId), JSON.stringify(stats))();
          },
          (error) => ({
            type: 'OPERATION',
            message: `Failed to set player stats: ${error}`,
          }),
        ),
      getLatestPlayerStats: (playerId: number) =>
        TE.tryCatch(
          async () => {
            const result = await redis.get(createKey(playerId))();
            return result._tag === 'Right' && result.right._tag === 'Some'
              ? (JSON.parse(result.right.value) as PlayerStat)
              : null;
          },
          (error) => ({
            type: 'OPERATION',
            message: `Failed to get latest player stats: ${error}`,
          }),
        ),
      setLatestPlayerStats: (playerId: number, stats: PlayerStat) =>
        TE.tryCatch(
          async () => {
            await redis.set(createKey(playerId), JSON.stringify(stats))();
          },
          (error) => ({
            type: 'OPERATION',
            message: `Failed to set latest player stats: ${error}`,
          }),
        ),
    }),
  );

  return domainCache as PlayerStatCacheOperations;
};

export const createPlayerStatsInvalidation = (cache: CacheOperations) => ({
  ...createCacheInvalidation(cache, DomainType.PLAYER_STAT),
});

export type PlayerStatsCache = ReturnType<typeof createPlayerStatsOperations>;
