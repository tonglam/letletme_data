import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainPlayerToPrismaCreate,
  mapPrismaPlayerToDomain,
} from 'src/repositories/player/mapper';
import { PlayerCreateInputs, PlayerRepository } from 'src/repositories/player/type';
import { Player, PlayerId, Players } from 'src/types/domain/player.type';

import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createPlayerRepository = (prisma: PrismaClient): PlayerRepository => {
  const findById = (element: PlayerId): TE.TaskEither<DBError, Player> =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findUnique({ where: { element: Number(element) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player by id ${element}: ${error}`,
          }),
      ),
      TE.chainW((prismaPlayerOrNull) =>
        prismaPlayerOrNull
          ? TE.right(mapPrismaPlayerToDomain(prismaPlayerOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Player with ID ${element} not found in database`,
              }),
            ),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, Players> =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findMany({ orderBy: { element: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all players: ${error}`,
          }),
      ),
      TE.map((prismaPlayers) => prismaPlayers.map(mapPrismaPlayerToDomain)),
    );

  const saveBatch = (players: PlayerCreateInputs): TE.TaskEither<DBError, Players> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = players.map(mapDomainPlayerToPrismaCreate);
          await prisma.player.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create players in batch: ${error}`,
          }),
      ),
      TE.chain(() => findAll()),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.player.deleteMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all players: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => void 0),
    );

  return {
    findById,
    findAll,
    saveBatch,
    deleteAll,
  };
};
