import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DBErrorCode, createDBError } from '../../types/error.type';
import {
  PlayerId,
  PlayerRepository,
  PrismaPlayer,
  PrismaPlayerCreate,
} from '../../types/player.type';

export const createPlayerRepository = (prisma: PrismaClient): PlayerRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to fetch all players',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findById: (id: PlayerId) =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findUnique({ where: { element: id } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player by id: ${id}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findByIds: (ids: PlayerId[]) =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findMany({ where: { element: { in: ids } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch players by ids: ${ids.join(', ')}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  save: (data: PrismaPlayerCreate) =>
    pipe(
      TE.tryCatch(
        () => prisma.player.create({ data }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to create player',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  saveBatch: (data: PrismaPlayerCreate[]) =>
    pipe(
      TE.tryCatch(
        () => prisma.player.createMany({ data }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to create players',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain(() =>
        pipe(
          TE.tryCatch(
            () =>
              prisma.player.findMany({
                where: {
                  element: {
                    in: data.map((d) => d.element),
                  },
                },
              }),
            (error) =>
              createDBError({
                code: DBErrorCode.QUERY_ERROR,
                message: 'Failed to fetch created players',
                cause: error instanceof Error ? error : new Error(String(error)),
              }),
          ),
        ),
      ),
    ),

  update: (id: PlayerId, data: PrismaPlayer) =>
    pipe(
      TE.tryCatch(
        () => prisma.player.update({ where: { element: id }, data }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to update player: ${id}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  updatePrices: (updates: readonly { id: PlayerId; price: number }[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          await prisma.$transaction(
            updates.map((update) =>
              prisma.player.update({
                where: { element: update.id },
                data: { price: update.price },
              }),
            ),
          );
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to update player prices',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.player.deleteMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to delete all players',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.map(() => undefined),
    ),

  deleteByIds: (ids: PlayerId[]) =>
    pipe(
      TE.tryCatch(
        () => prisma.player.deleteMany({ where: { element: { in: ids } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete players by ids: ${ids.join(', ')}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.map(() => undefined),
    ),
});
