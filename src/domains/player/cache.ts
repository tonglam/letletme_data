import { PlayerCache, PlayerCacheConfig } from 'domains/player/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { redisClient } from 'src/infrastructures/cache/client';
import { PlayerRepository } from 'src/repositories/player/type';
import { Player, Players } from 'src/types/domain/player.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'src/types/error.type';
import { getCurrentSeason } from 'src/utils/common.util';
import { mapCacheErrorToDomainError, mapRepositoryErrorToCacheError } from 'src/utils/error.util';

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
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as Player)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid Player structure',
            }),
          ),
    ),
  );

const parsePlayers = (playersMap: Record<string, string>): E.Either<CacheError, Players> =>
  pipe(
    Object.values(playersMap),
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
  repository: PlayerRepository,
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
            () =>
              pipe(
                repository.findAll(),
                TE.mapLeft(
                  mapRepositoryErrorToCacheError('Repository Error: Failed to get all players'),
                ),
                (task: TE.TaskEither<CacheError, Players>) => task,
                TE.mapLeft(mapCacheErrorToDomainError),
                TE.chainFirst((players) => setAllPlayers(players)),
              ),
            (cachedPlayers) =>
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
              items[player.element.toString()] = JSON.stringify(player);
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

  const deleteAllPlayers = (): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.del(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to delete all players',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getAllPlayers,
    setAllPlayers,
    deleteAllPlayers,
  };
};
