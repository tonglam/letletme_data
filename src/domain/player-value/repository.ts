import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { ValueChangeType } from '../../types/base.type';
import { DBErrorCode, createDBError } from '../../types/error.type';
import {
  PlayerValueId,
  PlayerValueRepository,
  PrismaPlayerValueCreate,
  PrismaPlayerValueUpdate,
} from '../../types/player-value.type';

export const createPlayerValueRepository = (prisma: PrismaClient): PlayerValueRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            orderBy: {
              changeDate: 'desc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all player values: ${error}`,
          }),
      ),
    ),

  findById: (id: PlayerValueId) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findUnique({
            where: {
              id: id,
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player value by id ${id}: ${error}`,
          }),
      ),
    ),

  findByIds: (ids: PlayerValueId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            where: {
              id: {
                in: [...ids],
              },
            },
            orderBy: {
              changeDate: 'desc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by ids: ${error}`,
          }),
      ),
    ),

  findByChangeDate: (changeDate: string) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            where: {
              changeDate,
            },
            orderBy: {
              elementId: 'asc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by change date ${changeDate}: ${error}`,
          }),
      ),
    ),

  findByElementId: (elementId: number) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            where: {
              elementId,
            },
            orderBy: {
              changeDate: 'desc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by element id ${elementId}: ${error}`,
          }),
      ),
    ),

  findByElementType: (elementType: number) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            where: {
              elementType: elementType,
            },
            orderBy: {
              changeDate: 'desc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by element type ${elementType}: ${error}`,
          }),
      ),
    ),

  findByChangeType: (changeType: ValueChangeType) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            where: {
              changeType,
            },
            orderBy: {
              changeDate: 'desc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by change type ${changeType}: ${error}`,
          }),
      ),
    ),

  findByEventId: (eventId: number) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            where: {
              eventId,
            },
            orderBy: {
              elementId: 'asc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by event id ${eventId}: ${error}`,
          }),
      ),
    ),

  save: (data: PrismaPlayerValueCreate) =>
    pipe(
      TE.tryCatch(
        async () => {
          try {
            return await prisma.playerValue.create({
              data,
            });
          } catch (error) {
            console.log('Prisma error:', error);
            if (error instanceof Error && error.message.includes('Unique constraint')) {
              throw new Error('Duplicate player value');
            }
            throw error;
          }
        },
        (error) => {
          if (error instanceof Error && error.message === 'Duplicate player value') {
            return createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: 'Duplicate player value',
            });
          }
          return createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create player value: ${error}`,
          });
        },
      ),
    ),

  saveBatch: (data: PrismaPlayerValueCreate[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          const results = await Promise.all(
            data.map((item) =>
              prisma.playerValue.create({
                data: item,
              }),
            ),
          );
          return results;
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create player values in batch: ${error}`,
          }),
      ),
    ),

  update: (id: PlayerValueId, playerValue: PrismaPlayerValueUpdate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.update({
            where: {
              id,
            },
            data: playerValue,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to update player value ${id}: ${error}`,
          }),
      ),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all player values: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),

  deleteByIds: (ids: PlayerValueId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.deleteMany({
            where: {
              id: {
                in: [...ids],
              },
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete player values by ids: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),
});
