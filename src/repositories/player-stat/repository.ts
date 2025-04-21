import { PrismaClient, PlayerStat as PrismaPlayerStatType } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainStatToPrismaCreate,
  mapPrismaPlayerStatToDomain,
} from 'src/repositories/player-stat/mapper';
import { PlayerStatCreateInputs, PlayerStatRepository } from 'src/repositories/player-stat/type';
import { SourcePlayerStats } from 'src/types/domain/player-stat.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createPlayerStatRepository = (prisma: PrismaClient): PlayerStatRepository => ({
  findLatest: (): TE.TaskEither<DBError, SourcePlayerStats> =>
    pipe(
      TE.tryCatch(
        async () => {
          const maxEventResult = await prisma.playerStat.aggregate({
            _max: { event: true },
          });
          const latestEvent = maxEventResult._max.event;

          if (latestEvent === null) {
            return [];
          }

          return prisma.playerStat.findMany({
            where: { event: latestEvent },
            orderBy: { element: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch latest player stats: ${error}`,
          }),
      ),
      TE.map((playerStats: PrismaPlayerStatType[]) => playerStats.map(mapPrismaPlayerStatToDomain)),
    ),

  saveLatest: (playerStats: PlayerStatCreateInputs): TE.TaskEither<DBError, SourcePlayerStats> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerStats.map(mapDomainStatToPrismaCreate);
          await prisma.playerStat.createMany({
            data: dataToCreate,
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

  deleteLatest: (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const maxEventResult = await prisma.playerStat.aggregate({
            _max: { event: true },
          });
          const latestEvent = maxEventResult._max.event;

          if (latestEvent === null) {
            return;
          }
          await prisma.playerStat.deleteMany({
            where: { event: latestEvent },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed deleteLatest for PlayerStat',
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => void 0),
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
