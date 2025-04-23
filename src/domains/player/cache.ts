import { PlayerCache, PlayerCacheConfig } from 'domains/player/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { redisClient } from 'src/infrastructures/cache/client';
import { Player, Players } from 'src/types/domain/player.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'src/types/error.type';
import { getCurrentSeason } from 'src/utils/common.util';
import { mapCacheErrorToDomainError } from 'src/utils/error.util';

const parsePlayer = (playerStr: string): E.Either<CacheError, Player> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(playerStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse player JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed &&
      typeof parsed === 'object' &&
      'id' in parsed &&
      typeof parsed.id === 'number' &&
      'type' in parsed &&
      typeof parsed.type === 'number'
        ? E.right(parsed as Player)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid Player structure (missing/invalid id or type)',
            }),
          ),
    ),
  );

const parsePlayers = (playerMaps: Record<string, string>): E.Either<CacheError, Players> =>
  pipe(
    Object.values(playerMaps),
    (playerStrs) =>
      playerStrs.map((str) =>
        pipe(
          parsePlayer(str),
          E.getOrElse<CacheError, Player | null>(() => null),
        ),
      ),
    (parsedPlayers) => parsedPlayers.filter((player): player is Player => player !== null),
    (validPlayers) => E.right(validPlayers),
  );

export const createPlayerCache = (
  config: PlayerCacheConfig = {
    keyPrefix: CachePrefix.PLAYER,
    season: getCurrentSeason(),
  },
): PlayerCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getAllPlayers = (): TE.TaskEither<DomainError, Players> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all players',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.filter((playersMap) => Object.keys(playersMap).length > 0),
          O.fold(
            () => TE.right([] as Players),
            (cachedPlayers): TE.TaskEither<DomainError, Players> =>
              pipe(
                parsePlayers(cachedPlayers),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
    );

  const setAllPlayers = (players: Players): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(baseKey);
          if (players.length > 0) {
            const items: Record<string, string> = {};
            players.forEach((player) => {
              items[player.id.toString()] = JSON.stringify(player);
            });
            multi.hset(baseKey, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to set all players',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getAllPlayers,
    setAllPlayers,
  };
};
