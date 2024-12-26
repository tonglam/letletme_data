import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createDatabaseError } from '../../infrastructure/api/common/errors';
import { Player } from '../../types/players.type';

export const createPlayerRepository = (prisma: PrismaClient) => {
  const findAll = (): TE.TaskEither<Error, ReadonlyArray<Player>> =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findMany(),
        (error) => createDatabaseError({ message: `Failed to fetch players: ${error}` }),
      ),
    );

  const findById = (id: number): TE.TaskEither<Error, Player> =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findUnique({ where: { element: id } }),
        (error) => createDatabaseError({ message: `Failed to fetch player: ${error}` }),
      ),
      TE.chain((player) =>
        player
          ? TE.right(player as Player)
          : TE.left(createDatabaseError({ message: `Player not found: ${id}` })),
      ),
    );

  const upsertMany = (players: ReadonlyArray<Player>): TE.TaskEither<Error, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.$transaction(
            players.map((player) =>
              prisma.player.upsert({
                where: { element: player.element },
                create: player,
                update: player,
              }),
            ),
          ),
        (error) => createDatabaseError({ message: `Failed to upsert players: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  const updateValue = (id: number, price: number): TE.TaskEither<Error, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.create({
            data: {
              elementId: id,
              value: price,
              elementType: 1, // TODO: Get from player
              eventId: 1, // TODO: Get from current event
              changeDate: new Date().toISOString(),
              changeType: 'Rise', // TODO: Calculate based on last value
              lastValue: 0, // TODO: Get from last value
            },
          }),
        (error) => createDatabaseError({ message: `Failed to update player value: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  const updateStats = (id: number, stats: Player): TE.TaskEither<Error, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.update({
            where: { element: id },
            data: stats,
          }),
        (error) => createDatabaseError({ message: `Failed to update player stats: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  return {
    findAll,
    findById,
    upsertMany,
    updateValue,
    updateStats,
  } as const;
};

export type PlayerRepository = ReturnType<typeof createPlayerRepository>;
