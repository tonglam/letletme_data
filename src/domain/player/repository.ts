import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createDBError, DBErrorCode } from '../../types/error.type';
import {
  PlayerId,
  PlayerRepository,
  PrismaPlayerCreate,
  PrismaPlayerUpdate,
} from '../../types/player.type';

export const createPlayerRepository = (prisma: PrismaClient): PlayerRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.findMany({
            orderBy: {
              element: 'asc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all players: ${error}`,
          }),
      ),
    ),

  findById: (id: PlayerId) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.findUnique({
            where: {
              element: Number(id),
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player by id ${id}: ${error}`,
          }),
      ),
    ),

  findByIds: (ids: PlayerId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.findMany({
            where: {
              element: {
                in: ids.map((id) => Number(id)),
              },
            },
            orderBy: {
              element: 'asc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch players by ids: ${error}`,
          }),
      ),
    ),

  save: (data: PrismaPlayerCreate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.create({
            data,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create player: ${error}`,
          }),
      ),
    ),

  saveBatch: (data: PrismaPlayerCreate[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.createMany({
            data,
            skipDuplicates: true,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create players in batch: ${error}`,
          }),
      ),
      TE.chain(() =>
        pipe(
          TE.tryCatch(
            () =>
              prisma.player.findMany({
                where: {
                  element: {
                    in: data.map((player) => player.element),
                  },
                },
                orderBy: {
                  element: 'asc',
                },
              }),
            (error) =>
              createDBError({
                code: DBErrorCode.QUERY_ERROR,
                message: `Failed to fetch created players: ${error}`,
              }),
          ),
        ),
      ),
    ),

  update: (id: PlayerId, player: PrismaPlayerUpdate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.update({
            where: {
              element: Number(id),
            },
            data: player,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to update player ${id}: ${error}`,
          }),
      ),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.player.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all players: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),

  deleteByIds: (ids: readonly PlayerId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.deleteMany({
            where: {
              element: {
                in: ids.map((id) => Number(id)),
              },
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete players by ids: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),
});
