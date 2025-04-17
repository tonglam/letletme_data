import { PrismaClient, Player as PrismaPlayerType } from '@prisma/client';
import { PlayerRepository } from 'domains/player/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainPlayerToPrismaCreate,
  mapPrismaPlayerToDomain,
} from 'src/repositories/player/mapper';
import { PrismaPlayerCreate } from 'src/repositories/player/type';
import { PlayerId } from 'src/types/domain/player.type';
import { createDBError, DBErrorCode } from '../../types/error.type';

export const createPlayerRepository = (prisma: PrismaClient): PlayerRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findMany({ orderBy: { element: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all players: ${error}`,
          }),
      ),
      TE.map((players: PrismaPlayerType[]) => players.map(mapPrismaPlayerToDomain)),
    ),

  findById: (id: PlayerId) =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findUnique({ where: { element: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player by id ${id}: ${error}`,
          }),
      ),
      TE.map((player: PrismaPlayerType | null) =>
        player ? mapPrismaPlayerToDomain(player) : null,
      ),
    ),

  saveBatch: (players: readonly PrismaPlayerCreate[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = players.map(mapDomainPlayerToPrismaCreate);
          await prisma.player.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });

          const ids = players.map((p) => p.id as number);

          return prisma.player.findMany({
            where: { element: { in: ids } },
            orderBy: { element: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create players in batch: ${error}`,
          }),
      ),
      TE.map((prismaPlayers: PrismaPlayerType[]) => prismaPlayers.map(mapPrismaPlayerToDomain)),
    ),

  deleteAll: () =>
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
      TE.map(() => undefined as void),
    ),
});
