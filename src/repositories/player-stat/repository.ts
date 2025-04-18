import { PrismaClient, PlayerStat as PrismaPlayerStatType } from '@prisma/client';
import { PlayerStatRepository } from 'domains/player-stat/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapPrismaPlayerStatToDomain } from 'src/repositories/player-stat/mapper';
import { PrismaPlayerStatCreateInput } from 'src/repositories/player-stat/type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerStatId } from 'src/types/domain/player-stat.type';
import { createDBError, DBErrorCode } from 'src/types/error.type';

export const createPlayerStatRepository = (prisma: PrismaClient): PlayerStatRepository => ({
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

  findById: (id: PlayerStatId) => {
    return pipe(
      TE.tryCatch(
        async () => {
          const result = await prisma.playerStat.findUnique({ where: { id } });
          return result;
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player stat by id ${id}: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map((playerStat) => (playerStat ? mapPrismaPlayerStatToDomain(playerStat) : null)),
    );
  },

  saveBatch: (playerStats: readonly PrismaPlayerStatCreateInput[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          await prisma.playerStat.createMany({ data: [...playerStats] });

          const uniqueIdentifiers = playerStats.map((p) => ({
            eventId: p.eventId,
            elementId: p.elementId,
          }));

          return prisma.playerStat.findMany({
            where: {
              OR: uniqueIdentifiers,
            },
            orderBy: { id: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save player stats batch: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map((createdPlayerStats: PrismaPlayerStatType[]) =>
        createdPlayerStats.map(mapPrismaPlayerStatToDomain),
      ),
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
      TE.map(() => undefined as void),
    ),

  deleteByEventId: (eventId: EventId) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerStat.deleteMany({ where: { eventId: eventId } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete player stats by event id ${eventId}: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => undefined as void),
    ),
});
