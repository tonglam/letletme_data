import { PrismaClient, PlayerStat as PrismaPlayerStatType } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainStatToPrismaCreate,
  mapPrismaPlayerStatToDomain,
} from 'src/repositories/player-stat/mapper';
import { PlayerStatCreateInputs, PlayerStatRepository } from 'src/repositories/player-stat/type';
import { RawPlayerStats } from 'src/types/domain/player-stat.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createPlayerStatRepository = (prisma: PrismaClient): PlayerStatRepository => {
  const findLatest = (): TE.TaskEither<DBError, RawPlayerStats> =>
    pipe(
      TE.tryCatch(
        async () => {
          const maxEventResult = await prisma.playerStat.aggregate({
            _max: { eventId: true },
          });
          const latestEvent = maxEventResult._max.eventId;

          if (latestEvent === null) {
            return [];
          }

          return prisma.playerStat.findMany({
            where: { eventId: latestEvent },
            orderBy: { elementId: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch latest player stats: ${error}`,
          }),
      ),
      TE.map((playerStats: PrismaPlayerStatType[]) => playerStats.map(mapPrismaPlayerStatToDomain)),
    );

  const saveLatest = (
    playerStatInputs: PlayerStatCreateInputs,
  ): TE.TaskEither<DBError, RawPlayerStats> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerStatInputs.map(mapDomainStatToPrismaCreate);
          await prisma.playerStat.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed saveBatch for PlayerStat',
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() => findLatest()),
    );

  const deleteLatest = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const maxEventResult = await prisma.playerStat.aggregate({
            _max: { eventId: true },
          });
          const latestEvent = maxEventResult._max.eventId;

          if (latestEvent === null) {
            return;
          }
          await prisma.playerStat.deleteMany({
            where: { eventId: latestEvent },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.OPERATION_ERROR,
            message: 'Failed deleteLatest for PlayerStat',
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findLatest,
    saveLatest,
    deleteLatest,
  };
};
