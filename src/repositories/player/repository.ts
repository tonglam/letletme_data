import { db } from 'db/index';
import { eq, asc } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDbPlayerToDomain, mapDomainPlayerToDbCreate } from 'repositories/player/mapper';
import { PlayerCreateInputs, PlayerRepository } from 'repositories/player/types';
import * as schema from 'schema/player';
import { PlayerId, RawPlayer, RawPlayers } from 'types/domain/player.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createPlayerRepository = (): PlayerRepository => {
  const findById = (id: PlayerId): TE.TaskEither<DBError, RawPlayer> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.players)
            .where(eq(schema.players.id, Number(id)));
          return mapDbPlayerToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player by id ${id}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, RawPlayers> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db.select().from(schema.players).orderBy(asc(schema.players.id));
          return result.map(mapDbPlayerToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all players: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatch = (playerInputs: PlayerCreateInputs): TE.TaskEither<DBError, RawPlayers> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerInputs.map(mapDomainPlayerToDbCreate);
          await db
            .insert(schema.players)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.players.id],
            });
        },
        (error) => {
          return createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create players in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          });
        },
      ),
      TE.chain(() => findAll()),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db.delete(schema.players);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all players: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  return {
    findById,
    findAll,
    saveBatch,
    deleteAll,
  };
};
