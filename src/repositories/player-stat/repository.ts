import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { PlayerStatRepository } from 'src/domains/player-stat/types';
import {
  mapDomainPlayerStatToPrismaCreate,
  mapPrismaPlayerStatToDomain,
} from 'src/repositories/player-stat/mapper';
import { PrismaPlayerStatCreate } from 'src/repositories/player-stat/type';
import { PlayerStatId } from 'src/types/domain/player-stat.type';
import { createDBError, DBErrorCode } from 'src/types/error.type';

export const createPlayerStatRepository = (prisma: PrismaClient): PlayerStatRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerStat.findMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all player stats: ${error}`,
          }),
      ),
      TE.map((playerStats) => playerStats.map(mapPrismaPlayerStatToDomain)),
    ),

  findById: (id: PlayerStatId) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerStat.findUnique({ where: { id } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player stat by id ${id}: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map((playerStat) => (playerStat ? mapPrismaPlayerStatToDomain(playerStat) : null)),
    ),

  saveBatch: (playerStats: readonly PrismaPlayerStatCreate[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerStats.map(mapDomainPlayerStatToPrismaCreate);
          await prisma.playerStat.createMany({ data: dataToCreate });

          const ids = playerStats.map((p) => Number(p.elementId));

          return prisma.playerStat.findMany({
            where: { elementId: { in: ids } },
            orderBy: { elementId: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save player stats: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map((playerStats) => playerStats.map(mapPrismaPlayerStatToDomain)),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerStat.deleteMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all player stats: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => undefined),
    ),
});
