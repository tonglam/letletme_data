import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { RedisClientType } from 'redis';
import { createDatabaseError } from '../../infrastructure/api/common/errors';
import { Player } from '../../types/players.type';

const PLAYER_KEY_PREFIX = 'player';
const PLAYER_TTL = 3600; // 1 hour

export const createPlayerCache = (redis: RedisClientType) => {
  const createKey = (id: number): string => `${PLAYER_KEY_PREFIX}:${id}`;

  const get = (id: number): TE.TaskEither<Error, Player | null> =>
    pipe(
      TE.tryCatch(
        async () => {
          const data = await redis.get(createKey(id));
          return data ? (JSON.parse(data) as Player) : null;
        },
        (error) => createDatabaseError({ message: `Failed to get player from cache: ${error}` }),
      ),
    );

  const set = (player: Player): TE.TaskEither<Error, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await redis.set(createKey(player.element), JSON.stringify(player), { EX: PLAYER_TTL });
        },
        (error) => createDatabaseError({ message: `Failed to set player in cache: ${error}` }),
      ),
    );

  const setMany = (players: ReadonlyArray<Player>): TE.TaskEither<Error, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const pipeline = redis.multi();
          players.forEach((player) => {
            pipeline.set(createKey(player.element), JSON.stringify(player), { EX: PLAYER_TTL });
          });
          await pipeline.exec();
        },
        (error) => createDatabaseError({ message: `Failed to set players in cache: ${error}` }),
      ),
    );

  const remove = (id: number): TE.TaskEither<Error, void> =>
    pipe(
      TE.tryCatch(
        () => redis.del(createKey(id)),
        (error) => createDatabaseError({ message: `Failed to remove player from cache: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  return {
    get,
    set,
    setMany,
    remove,
  } as const;
};

export type PlayerCache = ReturnType<typeof createPlayerCache>;
