import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainPlayerToPrismaCreate,
  mapPrismaPlayerToDomain,
} from 'src/repositories/player/mapper';
import { PlayerCreateInputs, PlayerRepository } from 'src/repositories/player/types';
import { PlayerId, RawPlayer, RawPlayers } from 'src/types/domain/player.type';

import { createDBError, DBError, DBErrorCode } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';

export const createPlayerRepository = (prisma: PrismaClient): PlayerRepository => {
  const findById = (id: PlayerId): TE.TaskEither<DBError, RawPlayer> =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player by id ${id}: ${getErrorMessage(error)}`,
          }),
      ),
      TE.chainW((prismaPlayerOrNull) =>
        prismaPlayerOrNull
          ? TE.right(mapPrismaPlayerToDomain(prismaPlayerOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Player with ID ${id} not found in database`,
              }),
            ),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, RawPlayers> =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findMany({ orderBy: { id: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all players: ${getErrorMessage(error)}`,
          }),
      ),
      TE.map((prismaPlayers) => prismaPlayers.map(mapPrismaPlayerToDomain)),
    );

  const saveBatch = (playerInputs: PlayerCreateInputs): TE.TaskEither<DBError, RawPlayers> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerInputs.map(mapDomainPlayerToPrismaCreate);
          await prisma.player.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
          const savedPlayers = await prisma.player.findMany({ orderBy: { id: 'asc' } });
          return savedPlayers.map(mapPrismaPlayerToDomain);
        },
        (error) => {
          return createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create players in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          });
        },
      ),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.player.deleteMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all players: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findById,
    findAll,
    saveBatch,
    deleteAll,
  };
};
