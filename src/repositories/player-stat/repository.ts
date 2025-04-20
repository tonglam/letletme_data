import { PrismaClient, PlayerStat as PrismaPlayerStatType } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainStatToPrismaCreateInput,
  mapPrismaPlayerStatToDomain,
} from 'src/repositories/player-stat/mapper';
import { PlayerStatRepository } from 'src/repositories/player-stat/type';
import { PlayerStats } from 'src/types/domain/player-stat.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createPlayerStatRepository = (prisma: PrismaClient): PlayerStatRepository => ({
  findByElement: (element: number): TE.TaskEither<DBError, PlayerStats> =>
    pipe(
      TE.tryCatch(
        () => prisma.playerStat.findMany({ where: { element } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed findByElement for PlayerStat with element ${element}: ${error}`,
          }),
      ),
      TE.map((prismaPlayerStats) => prismaPlayerStats.map(mapPrismaPlayerStatToDomain)),
    ),

  findByElements: (elements: number[]): TE.TaskEither<DBError, PlayerStats> =>
    pipe(
      TE.tryCatch(
        () => prisma.playerStat.findMany({ where: { element: { in: elements } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed findByElements for PlayerStat with elements ${elements}: ${error}`,
          }),
      ),
      TE.map((prismaPlayerStats) => prismaPlayerStats.map(mapPrismaPlayerStatToDomain)),
    ),

  findByEvent: (event: number): TE.TaskEither<DBError, PlayerStats> =>
    pipe(
      TE.tryCatch(
        () => prisma.playerStat.findMany({ where: { event } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed findByEvent for PlayerStat with event ${event}: ${error}`,
          }),
      ),
      TE.map((prismaPlayerStats) => prismaPlayerStats.map(mapPrismaPlayerStatToDomain)),
    ),

  findAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerStat.findMany({ orderBy: { id: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all player stats: ${error}`,
          }),
      ),
      TE.map((playerStats: PrismaPlayerStatType[]) => playerStats.map(mapPrismaPlayerStatToDomain)),
    ),

  saveBatch: (playerStats: PlayerStats): TE.TaskEither<DBError, PlayerStats> =>
    pipe(
      TE.tryCatch(
        async () => {
          const prismaData = playerStats.map((stat) => mapDomainStatToPrismaCreateInput(stat));
          await prisma.playerStat.createMany({
            data: prismaData,
            skipDuplicates: true,
          });
          return playerStats;
        },
        (error) =>
          createDBError({
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed saveBatch for PlayerStat',
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    ),

  deleteAll: (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await prisma.playerStat.deleteMany({});
        },
        (error) =>
          createDBError({
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed deleteAll for PlayerStat',
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => void 0),
    ),
});
