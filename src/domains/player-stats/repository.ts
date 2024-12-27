import { APIError, createDatabaseError } from '@infrastructure/errors';
import { PrismaClient } from '@prisma/client';
import { PlayerStat, PlayerStatsResponse, toDomainPlayerStats } from '@types/playerStats.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createPlayerStatsRepository = (prisma: PrismaClient) => {
  const findByPlayerId = (
    playerId: number,
    eventId: number,
  ): TE.TaskEither<APIError, ReadonlyArray<PlayerStat>> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStats.findMany({
            where: { elementId: playerId, eventId },
            orderBy: { eventId: 'desc' },
          }),
        (error) => createDatabaseError({ message: `Failed to fetch player stats: ${error}` }),
      ),
      TE.map((stats) => stats as ReadonlyArray<PlayerStat>),
    );

  const findLatestByPlayerId = (playerId: number): TE.TaskEither<APIError, PlayerStat | null> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStats.findFirst({
            where: { elementId: playerId },
            orderBy: { eventId: 'desc' },
          }),
        (error) =>
          createDatabaseError({ message: `Failed to fetch latest player stats: ${error}` }),
      ),
      TE.map((stats) => (stats ? (stats as PlayerStat) : null)),
    );

  const upsertStats = (stats: PlayerStat): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStats.upsert({
            where: {
              elementId_eventId: {
                elementId: stats.elementId,
                eventId: stats.eventId,
              },
            },
            create: stats as any,
            update: stats as any,
          }),
        (error) => createDatabaseError({ message: `Failed to upsert player stats: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  const upsertMany = (stats: ReadonlyArray<PlayerStat>): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.$transaction(
            stats.map((stat) =>
              prisma.playerStats.upsert({
                where: {
                  elementId_eventId: {
                    elementId: stat.elementId,
                    eventId: stat.eventId,
                  },
                },
                create: stat as any,
                update: stat as any,
              }),
            ),
          ),
        (error) => createDatabaseError({ message: `Failed to upsert player stats: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  const processStatsResponse = (
    response: PlayerStatsResponse,
    eventId: number,
  ): TE.TaskEither<APIError, void> => pipe(toDomainPlayerStats(response), TE.chain(upsertMany));

  return {
    findByPlayerId,
    findLatestByPlayerId,
    upsertStats,
    upsertMany,
    processStatsResponse,
  } as const;
};

export type PlayerStatsRepository = ReturnType<typeof createPlayerStatsRepository>;
