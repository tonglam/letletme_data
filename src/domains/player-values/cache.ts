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
import { PlayerValue } from '../../types/player-values.type';

export type PlayerValueDataProvider = BaseDataProvider<PlayerValue>;

export interface PlayerValueCacheOperations extends DomainCacheOperations<PlayerValue> {
  readonly getPlayerValues: (
    playerId: number,
    eventId: number,
  ) => TE.TaskEither<CacheError, readonly PlayerValue[]>;
  readonly setPlayerValues: (
    playerId: number,
    eventId: number,
    values: readonly PlayerValue[],
  ) => TE.TaskEither<CacheError, void>;
  readonly getLatestPlayerValue: (
    playerId: number,
  ) => TE.TaskEither<CacheError, PlayerValue | null>;
  readonly setLatestPlayerValue: (
    playerId: number,
    value: PlayerValue,
  ) => TE.TaskEither<CacheError, void>;
}

export const createPlayerValuesOperations = (
  redis: RedisClient,
  dataProvider: PlayerValueDataProvider,
): PlayerValueCacheOperations => {
  const createKey = (playerId: number, eventId?: number) =>
    eventId ? `player:${playerId}:values:event:${eventId}` : `player:${playerId}:values:latest`;

  const domainCache = createDomainCache(
    redis,
    'PLAYER_VALUE',
    dataProvider,
    'player-value',
    (baseOps) => ({
      ...baseOps,
      getPlayerValues: (playerId: number, eventId: number) =>
        TE.tryCatch(
          async () => {
            const result = await redis.get(createKey(playerId, eventId))();
            return result._tag === 'Right' && result.right._tag === 'Some'
              ? (JSON.parse(result.right.value) as readonly PlayerValue[])
              : [];
          },
          (error) => ({
            type: 'OPERATION',
            message: `Failed to get player values: ${error}`,
          }),
        ),
      setPlayerValues: (playerId: number, eventId: number, values: readonly PlayerValue[]) =>
        TE.tryCatch(
          async () => {
            await redis.set(createKey(playerId, eventId), JSON.stringify(values))();
          },
          (error) => ({
            type: 'OPERATION',
            message: `Failed to set player values: ${error}`,
          }),
        ),
      getLatestPlayerValue: (playerId: number) =>
        TE.tryCatch(
          async () => {
            const result = await redis.get(createKey(playerId))();
            return result._tag === 'Right' && result.right._tag === 'Some'
              ? (JSON.parse(result.right.value) as PlayerValue)
              : null;
          },
          (error) => ({
            type: 'OPERATION',
            message: `Failed to get latest player value: ${error}`,
          }),
        ),
      setLatestPlayerValue: (playerId: number, value: PlayerValue) =>
        TE.tryCatch(
          async () => {
            await redis.set(createKey(playerId), JSON.stringify(value))();
          },
          (error) => ({
            type: 'OPERATION',
            message: `Failed to set latest player value: ${error}`,
          }),
        ),
    }),
  );

  return domainCache as PlayerValueCacheOperations;
};

export const createPlayerValuesInvalidation = (cache: CacheOperations) => ({
  ...createCacheInvalidation(cache, DomainType.PLAYER_VALUE),
});

export type PlayerValuesCache = ReturnType<typeof createPlayerValuesOperations>;
